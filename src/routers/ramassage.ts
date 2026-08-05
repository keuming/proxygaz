import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { and, eq, gt, sql, desc } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { router, publicProcedure, protectedProcedure, requireRole } from "../trpc.js";
import { db, schema } from "../db/index.js";

const { demandesRamassage, ramasseurs, societesLivraison, notifications, mouvementsCredit, demandesCredit } = schema;

/**
 * Distance à vol d'oiseau entre deux points GPS (formule de Haversine), en kilomètres.
 * Identique à celle de gaz.ts — pas de module partagé pour rester simple, les deux
 * routers sont indépendants.
 */
function distanceKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export const ramassageRouter = router({
  // Le client crée une demande de ramassage — fonctionne connecté OU en tant qu'invité,
  // même logique que gaz.creerCommande : compte créé/réutilisé silencieusement si besoin.
  creerDemande: publicProcedure
    .input(
      z.object({
        adresse: z.string().min(5),
        latitude: z.number().optional(),
        longitude: z.number().optional(),
        ville: z.string().min(2),
        commune: z.string().optional(),
        typeDechet: z.string().default("menager"),
        quantiteEstimee: z.string().optional(),
        prixPropose: z.number().optional(),
        modePaiement: z.enum(["mobile_money", "especes_livraison"]).optional(),
        // Renseignés uniquement si la personne n'est pas déjà connectée
        nomClient: z.string().min(2).optional(),
        telephoneClient: z.string().min(8).optional(),
        motDePasseClient: z.string().min(6).optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      let clientId: string;
      let tokenGenere: string | undefined;
      let userGenere: { id: string; nom: string; role: string } | undefined;

      if (ctx.user) {
        clientId = ctx.user.id;
      } else {
        if (!input.nomClient || !input.telephoneClient) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Nom et téléphone requis pour envoyer une demande sans compte",
          });
        }

        const [existant] = await db
          .select()
          .from(schema.utilisateurs)
          .where(eq(schema.utilisateurs.telephone, input.telephoneClient));

        if (existant) {
          clientId = existant.id;
        } else {
          const bcrypt = (await import("bcryptjs")).default;
          const motDePasseHash = await bcrypt.hash(input.motDePasseClient ?? randomUUID(), 10);

          const [nouveauClient] = await db
            .insert(schema.utilisateurs)
            .values({
              nom: input.nomClient,
              telephone: input.telephoneClient,
              motDePasseHash,
              ville: input.ville,
              commune: input.commune,
              role: "client",
            })
            .returning();
          clientId = nouveauClient.id;
        }

        const jwt = (await import("jsonwebtoken")).default;
        const [utilisateurComplet] = await db
          .select()
          .from(schema.utilisateurs)
          .where(eq(schema.utilisateurs.id, clientId));

        tokenGenere = jwt.sign(
          { id: utilisateurComplet.id, role: utilisateurComplet.role, telephone: utilisateurComplet.telephone },
          process.env.JWT_SECRET as string,
          { expiresIn: "30d" }
        );
        userGenere = { id: utilisateurComplet.id, nom: utilisateurComplet.nom, role: utilisateurComplet.role };
      }

      const encaisseImmediatement = input.modePaiement === "mobile_money";

      const [demande] = await db
        .insert(demandesRamassage)
        .values({
          clientId,
          adresse: input.adresse,
          latitude: input.latitude,
          longitude: input.longitude,
          ville: input.ville,
          commune: input.commune,
          typeDechet: input.typeDechet,
          quantiteEstimee: input.quantiteEstimee,
          prixPropose: input.prixPropose?.toString(),
          modePaiement: input.modePaiement,
          encaisse: encaisseImmediatement,
          encaisseAt: encaisseImmediatement ? new Date() : undefined,
          statut: "en_attente",
        })
        .returning();

      // TODO: notifier par push/SMS tous les ramasseurs validés couvrant cette commune/ville
      return { demande, token: tokenGenere, user: userGenere };
    }),

  // Liste des demandes disponibles pour un ramasseur (dans sa zone, statut en_attente)
  demandesDisponibles: requireRole("ramasseur").query(async ({ ctx }) => {
    const [profilRamasseur] = await db
      .select()
      .from(ramasseurs)
      .where(eq(ramasseurs.utilisateurId, ctx.user.id));

    if (!profilRamasseur) {
      throw new TRPCError({ code: "NOT_FOUND", message: "Profil ramasseur introuvable" });
    }

    const zones = profilRamasseur.zonesCouvertes as string[];

    const demandes = await db
      .select()
      .from(demandesRamassage)
      .where(eq(demandesRamassage.statut, "en_attente"));

    const latRef = profilRamasseur.positionActuelleLat ?? profilRamasseur.latitude;
    const lngRef = profilRamasseur.positionActuelleLng ?? profilRamasseur.longitude;

    // Filtre applicatif par zone (commune/ville incluse dans zonesCouvertes)
    const resultats = demandes
      .filter((d) => zones.includes(d.commune ?? "") || zones.includes(d.ville))
      .map((d) => {
        const distance =
          latRef != null && lngRef != null && d.latitude != null && d.longitude != null
            ? distanceKm(latRef, lngRef, d.latitude, d.longitude)
            : null;
        return { ...d, distanceKm: distance !== null ? Math.round(distance * 10) / 10 : null };
      });

    resultats.sort((a, b) => {
      if (a.distanceKm === null && b.distanceKm === null) return 0;
      if (a.distanceKm === null) return 1;
      if (b.distanceKm === null) return -1;
      return a.distanceKm - b.distanceKm;
    });

    return resultats;
  }),

  // Le ramasseur transmet sa position GPS en direct pendant qu'il est actif.
  majPositionRamasseur: requireRole("ramasseur")
    .input(z.object({ latitude: z.number(), longitude: z.number() }))
    .mutation(async ({ ctx, input }) => {
      const [profilRamasseur] = await db
        .select()
        .from(ramasseurs)
        .where(eq(ramasseurs.utilisateurId, ctx.user.id));
      if (!profilRamasseur) throw new TRPCError({ code: "NOT_FOUND", message: "Profil ramasseur introuvable" });

      await db
        .update(ramasseurs)
        .set({
          positionActuelleLat: input.latitude,
          positionActuelleLng: input.longitude,
          positionMajAt: new Date(),
        })
        .where(eq(ramasseurs.id, profilRamasseur.id));

      return { ok: true };
    }),

  /**
   * VALIDATION D'UNE DEMANDE - "premier qui valide, gagne"
   *
   * Le point critique : plusieurs ramasseurs peuvent taper sur "j'accepte" en même temps.
   * On utilise un UPDATE conditionnel atomique (WHERE statut = 'en_attente') plutôt
   * qu'un SELECT puis UPDATE, pour éviter la race condition. PostgreSQL garantit
   * qu'un seul UPDATE concurrent réussira à changer la ligne ; les autres verront
   * 0 ligne affectée et recevront une erreur "déjà pris".
   */
  validerDemande: requireRole("ramasseur")
    .input(z.object({ demandeId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const [profilRamasseur] = await db
        .select()
        .from(ramasseurs)
        .where(eq(ramasseurs.utilisateurId, ctx.user.id));

      if (!profilRamasseur || profilRamasseur.statutValidation !== "valide") {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Profil ramasseur non validé",
        });
      }

      // Frais de service ProxiGaz : 1 crédit (100 FCFA) réservé avant d'accepter la demande.
      // Si le ramasseur appartient à une société de livraison, c'est le pot commun de la
      // société qui est débité, pas son solde individuel — même logique que les livreurs.
      const appartientAUneSociete = !!profilRamasseur.societeLivraisonId;

      let soldeApresDebit: number;
      if (appartientAUneSociete) {
        const [societeDebitee] = await db
          .update(societesLivraison)
          .set({ credits: sql`${societesLivraison.credits} - 1` })
          .where(
            and(eq(societesLivraison.id, profilRamasseur.societeLivraisonId!), gt(societesLivraison.credits, 0))
          )
          .returning();

        if (!societeDebitee) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "Crédit de votre société épuisé. Contactez votre société pour recharger le pot commun.",
          });
        }
        soldeApresDebit = societeDebitee.credits;
      } else {
        const [ramasseurDebite] = await db
          .update(ramasseurs)
          .set({ credits: sql`${ramasseurs.credits} - 1` })
          .where(and(eq(ramasseurs.id, profilRamasseur.id), gt(ramasseurs.credits, 0)))
          .returning();

        if (!ramasseurDebite) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "Crédit insuffisant. Achetez des crédits pour accepter des demandes.",
          });
        }
        soldeApresDebit = ramasseurDebite.credits;
      }

      // UPDATE atomique conditionné sur le statut actuel : un seul appel concurrent
      // peut réussir à faire passer la ligne de 'en_attente' à 'validee'.
      const [demandeMiseAJour] = await db
        .update(demandesRamassage)
        .set({
          statut: "validee",
          ramasseurId: profilRamasseur.id,
          validatedAt: new Date(),
        })
        .where(
          and(
            eq(demandesRamassage.id, input.demandeId),
            eq(demandesRamassage.statut, "en_attente")
          )
        )
        .returning();

      if (!demandeMiseAJour) {
        // La demande a été prise entretemps par un autre ramasseur : on rembourse le crédit,
        // à la société si c'était son pot commun, sinon au ramasseur lui-même.
        if (appartientAUneSociete) {
          const [rembourse] = await db
            .update(societesLivraison)
            .set({ credits: sql`${societesLivraison.credits} + 1` })
            .where(eq(societesLivraison.id, profilRamasseur.societeLivraisonId!))
            .returning();

          await db.insert(mouvementsCredit).values({
            societeLivraisonId: profilRamasseur.societeLivraisonId!,
            typeMouvement: "ajustement",
            quantite: 1,
            soldeApres: rembourse.credits,
            reference: input.demandeId,
            notes: `Remboursement : demande déjà prise par un autre ramasseur (${profilRamasseur.nomSociete ?? "ramasseur société"})`,
          });
        } else {
          const [rembourse] = await db
            .update(ramasseurs)
            .set({ credits: sql`${ramasseurs.credits} + 1` })
            .where(eq(ramasseurs.id, profilRamasseur.id))
            .returning();

          await db.insert(mouvementsCredit).values({
            ramasseurId: profilRamasseur.id,
            typeMouvement: "ajustement",
            quantite: 1,
            soldeApres: rembourse.credits,
            reference: input.demandeId,
            notes: "Remboursement : demande déjà prise par un autre ramasseur",
          });
        }

        throw new TRPCError({
          code: "CONFLICT",
          message: "Cette demande a déjà été prise par un autre ramasseur",
        });
      }

      await db.insert(mouvementsCredit).values({
        ramasseurId: appartientAUneSociete ? undefined : profilRamasseur.id,
        societeLivraisonId: appartientAUneSociete ? profilRamasseur.societeLivraisonId! : undefined,
        typeMouvement: "debit_ramassage",
        quantite: -1,
        soldeApres: soldeApresDebit,
        reference: demandeMiseAJour.id,
        notes: appartientAUneSociete
          ? "Frais de service ProxiGaz (100 FCFA) — ramasseur rattaché à une société"
          : "Frais de service ProxiGaz (100 FCFA)",
      });

      await db.insert(notifications).values({
        utilisateurId: demandeMiseAJour.clientId,
        titre: "Ramasseur trouvé",
        message: `${profilRamasseur.nomSociete ?? "Un ramasseur"} a accepté votre demande de ramassage.`,
        type: "ramassage",
      });

      return demandeMiseAJour;
    }),

  // Transition validee -> en_cours (déclenchée par le ramasseur assigné quand il démarre)
  demarrerRamassage: requireRole("ramasseur")
    .input(z.object({ demandeId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const [profilRamasseur] = await db
        .select()
        .from(ramasseurs)
        .where(eq(ramasseurs.utilisateurId, ctx.user.id));

      if (!profilRamasseur) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Profil ramasseur introuvable" });
      }

      const [demande] = await db
        .update(demandesRamassage)
        .set({ statut: "en_cours" })
        .where(
          and(
            eq(demandesRamassage.id, input.demandeId),
            eq(demandesRamassage.ramasseurId, profilRamasseur.id),
            eq(demandesRamassage.statut, "validee")
          )
        )
        .returning();

      if (!demande) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "La demande doit être validée et vous être attribuée avant de démarrer",
        });
      }

      return demande;
    }),

  // Le ramasseur marque la demande comme terminée
  terminerDemande: requireRole("ramasseur")
    .input(z.object({ demandeId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const [profilRamasseur] = await db
        .select()
        .from(ramasseurs)
        .where(eq(ramasseurs.utilisateurId, ctx.user.id));

      if (!profilRamasseur) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Profil ramasseur introuvable" });
      }

      const [demande] = await db
        .update(demandesRamassage)
        .set({
          statut: "terminee",
          terminatedAt: new Date(),
          encaisse: sql`CASE WHEN ${demandesRamassage.modePaiement} = 'especes_livraison' THEN true ELSE ${demandesRamassage.encaisse} END`,
          encaisseAt: sql`CASE WHEN ${demandesRamassage.modePaiement} = 'especes_livraison' AND ${demandesRamassage.encaisse} = false THEN now() ELSE ${demandesRamassage.encaisseAt} END`,
        })
        .where(
          and(
            eq(demandesRamassage.id, input.demandeId),
            eq(demandesRamassage.ramasseurId, profilRamasseur.id),
            eq(demandesRamassage.statut, "en_cours")
          )
        )
        .returning();

      if (!demande) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Impossible de terminer cette demande (statut ou attribution incorrecte)",
        });
      }

      await db
        .update(ramasseurs)
        .set({ nombreRamassages: sql`${ramasseurs.nombreRamassages} + 1` })
        .where(eq(ramasseurs.id, profilRamasseur.id));

      return demande;
    }),

  // Suivi client : liste de ses demandes
  mesDemandesClient: protectedProcedure.query(async ({ ctx }) => {
    return db
      .select()
      .from(demandesRamassage)
      .where(eq(demandesRamassage.clientId, ctx.user.id));
  }),

  // Suivi ramasseur : ses propres demandes acceptées (validee, en_cours, terminee)
  mesRamassages: requireRole("ramasseur").query(async ({ ctx }) => {
    const [profilRamasseur] = await db
      .select()
      .from(ramasseurs)
      .where(eq(ramasseurs.utilisateurId, ctx.user.id));

    if (!profilRamasseur) {
      throw new TRPCError({ code: "NOT_FOUND", message: "Profil ramasseur introuvable" });
    }

    return db
      .select()
      .from(demandesRamassage)
      .where(eq(demandesRamassage.ramasseurId, profilRamasseur.id));
  }),

  statsRamasseur: requireRole("ramasseur").query(async ({ ctx }) => {
    const [profilRamasseur] = await db
      .select()
      .from(ramasseurs)
      .where(eq(ramasseurs.utilisateurId, ctx.user.id));

    if (!profilRamasseur) {
      throw new TRPCError({ code: "NOT_FOUND", message: "Profil ramasseur introuvable" });
    }

    const debutMois = new Date();
    debutMois.setDate(1);
    debutMois.setHours(0, 0, 0, 0);

    const toutes = await db
      .select()
      .from(demandesRamassage)
      .where(eq(demandesRamassage.ramasseurId, profilRamasseur.id));

    const terminees = toutes.filter((d) => d.statut === "terminee");
    const termineesCeMois = terminees.filter((d) => d.terminatedAt && d.terminatedAt >= debutMois);

    return {
      totalRamassages: terminees.length,
      ramassagesCeMois: termineesCeMois.length,
      enCoursActuellement: toutes.filter((d) => d.statut === "en_cours").length,
      valideesEnAttenteDeDemarrage: toutes.filter((d) => d.statut === "validee").length,
    };
  }),

  // ---- Encaissements (fenêtre de monitoring espèces vs MobilePay) ----
  mesEncaissements: requireRole("ramasseur")
    .input(z.object({ depuis: z.string().datetime().optional() }).optional())
    .query(async ({ ctx, input }) => {
      const profilRows = await db
        .select({
          ramasseur: ramasseurs,
          ramasseurTelephone: schema.utilisateurs.telephone,
          ramasseurNom: schema.utilisateurs.nom,
        })
        .from(ramasseurs)
        .innerJoin(schema.utilisateurs, eq(ramasseurs.utilisateurId, schema.utilisateurs.id))
        .where(eq(ramasseurs.utilisateurId, ctx.user.id));

      const profilRamasseur = profilRows[0]?.ramasseur;
      if (!profilRamasseur) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Profil ramasseur introuvable" });
      }

      const conditions = [
        eq(demandesRamassage.ramasseurId, profilRamasseur.id),
        eq(demandesRamassage.encaisse, true),
      ];
      if (input?.depuis) {
        conditions.push(sql`${demandesRamassage.encaisseAt} >= ${input.depuis}::timestamp`);
      }

      const rows = await db
        .select({
          demande: demandesRamassage,
          clientNom: schema.utilisateurs.nom,
          clientTelephone: schema.utilisateurs.telephone,
        })
        .from(demandesRamassage)
        .innerJoin(schema.utilisateurs, eq(demandesRamassage.clientId, schema.utilisateurs.id))
        .where(and(...conditions));

      const transactions = rows.map((r) => ({
        ...r.demande,
        clientNom: r.clientNom,
        clientTelephone: r.clientTelephone,
      }));

      const totalEspeces = transactions
        .filter((t) => t.modePaiement === "especes_livraison")
        .reduce((s, t) => s + Number(t.prixPropose ?? 0), 0);
      const totalMobilePay = transactions
        .filter((t) => t.modePaiement === "mobile_money")
        .reduce((s, t) => s + Number(t.prixPropose ?? 0), 0);

      return {
        ramasseur: {
          nom: profilRows[0].ramasseur.nomSociete ?? profilRows[0].ramasseurNom,
          telephone: profilRows[0].ramasseurTelephone,
        },
        transactions,
        totaux: {
          especes: totalEspeces,
          mobilePay: totalMobilePay,
          global: totalEspeces + totalMobilePay,
          nbTransactions: transactions.length,
        },
      };
    }),

  // ---- Système de crédit (frais de service : 1 crédit = 100 FCFA / demande acceptée) ----

  mesCreditsRamasseur: requireRole("ramasseur").query(async ({ ctx }) => {
    const [profilRamasseur] = await db
      .select()
      .from(ramasseurs)
      .where(eq(ramasseurs.utilisateurId, ctx.user.id));
    if (!profilRamasseur) throw new TRPCError({ code: "NOT_FOUND", message: "Profil ramasseur introuvable" });
    return { credits: profilRamasseur.credits };
  }),

  mesMouvementsCreditRamasseur: requireRole("ramasseur").query(async ({ ctx }) => {
    const [profilRamasseur] = await db
      .select()
      .from(ramasseurs)
      .where(eq(ramasseurs.utilisateurId, ctx.user.id));
    if (!profilRamasseur) throw new TRPCError({ code: "NOT_FOUND", message: "Profil ramasseur introuvable" });

    return db
      .select()
      .from(mouvementsCredit)
      .where(eq(mouvementsCredit.ramasseurId, profilRamasseur.id))
      .orderBy(desc(mouvementsCredit.createdAt))
      .limit(100);
  }),

  mesDemandesCreditRamasseur: requireRole("ramasseur").query(async ({ ctx }) => {
    const [profilRamasseur] = await db
      .select()
      .from(ramasseurs)
      .where(eq(ramasseurs.utilisateurId, ctx.user.id));
    if (!profilRamasseur) throw new TRPCError({ code: "NOT_FOUND", message: "Profil ramasseur introuvable" });

    return db
      .select()
      .from(demandesCredit)
      .where(eq(demandesCredit.ramasseurId, profilRamasseur.id))
      .orderBy(desc(demandesCredit.createdAt));
  }),

  demanderCreditRamasseur: requireRole("ramasseur")
    .input(
      z.object({
        quantiteCredits: z.number().int().positive(),
        referencePaiement: z.string().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const [profilRamasseur] = await db
        .select()
        .from(ramasseurs)
        .where(eq(ramasseurs.utilisateurId, ctx.user.id));
      if (!profilRamasseur) throw new TRPCError({ code: "NOT_FOUND", message: "Profil ramasseur introuvable" });

      if (profilRamasseur.societeLivraisonId) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message:
            "Vous faites partie d'une société de livraison — c'est elle qui recharge le pot commun de crédits, pas vous individuellement.",
        });
      }

      const [demande] = await db
        .insert(demandesCredit)
        .values({
          ramasseurId: profilRamasseur.id,
          quantiteCredits: input.quantiteCredits,
          montantPaye: (input.quantiteCredits * 100).toString(),
          modePaiement: "mobile_money",
          referencePaiement: input.referencePaiement,
          statut: "en_attente",
        })
        .returning();

      return demande;
    }),

  // ============================================================
  // SOCIÉTÉ DE LIVRAISON — gestion de ses propres ramasseurs
  // ============================================================

  // Liste des ramasseurs rattachés à cette société (utilisée aussi côté admin pour le
  // regroupement par société dans la liste générale des ramasseurs).
  mesRamasseursSociete: requireRole("societe_livraison").query(async ({ ctx }) => {
    const [societe] = await db
      .select()
      .from(societesLivraison)
      .where(eq(societesLivraison.utilisateurId, ctx.user.id));
    if (!societe) throw new TRPCError({ code: "NOT_FOUND", message: "Profil société introuvable" });

    return db
      .select()
      .from(ramasseurs)
      .where(eq(ramasseurs.societeLivraisonId, societe.id))
      .orderBy(desc(ramasseurs.createdAt));
  }),

  // La société ajoute un ramasseur sous son propre compte. Le ramasseur créé garde son
  // propre accès (téléphone + PIN) pour accepter ses demandes sur le terrain, mais son
  // crédit est celui du pot commun de la société — même logique que pour un livreur.
  ajouterRamasseurSousSociete: requireRole("societe_livraison")
    .input(
      z.object({
        nom: z.string().min(2),
        telephone: z.string().min(8),
        codePin: z.string().regex(/^\d{4}$/, "Le code PIN doit comporter exactement 4 chiffres"),
        vehicule: z.string().optional(),
        zonesCouvertes: z.array(z.string()).min(1),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const [societe] = await db
        .select()
        .from(societesLivraison)
        .where(eq(societesLivraison.utilisateurId, ctx.user.id));
      if (!societe) throw new TRPCError({ code: "NOT_FOUND", message: "Profil société introuvable" });

      if (societe.statutValidation !== "valide") {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Votre société doit être validée par ProxiGaz avant de pouvoir ajouter des ramasseurs",
        });
      }

      const bcrypt = (await import("bcryptjs")).default;

      const existant = await db
        .select()
        .from(schema.utilisateurs)
        .where(eq(schema.utilisateurs.telephone, input.telephone));
      if (existant.length > 0) {
        throw new TRPCError({ code: "CONFLICT", message: "Ce numéro est déjà utilisé" });
      }

      const motDePasseHash = await bcrypt.hash(input.codePin, 10);

      const [user] = await db
        .insert(schema.utilisateurs)
        .values({
          nom: input.nom,
          telephone: input.telephone,
          motDePasseHash,
          ville: societe.ville,
          commune: societe.commune,
          role: "ramasseur",
        })
        .returning();

      const [ramasseurCree] = await db
        .insert(ramasseurs)
        .values({
          utilisateurId: user.id,
          societeLivraisonId: societe.id,
          type: "societe",
          vehicule: input.vehicule,
          zonesCouvertes: input.zonesCouvertes,
          pays: societe.pays,
          ville: societe.ville,
          commune: societe.commune,
          quartier: societe.quartier,
          latitude: societe.latitude,
          longitude: societe.longitude,
          statutValidation: "valide", // la société est déjà validée, ses ramasseurs le sont d'office
          credits: 0, // inutilisé : ce ramasseur puise dans le pot commun de la société
        })
        .returning();

      return { utilisateur: { id: user.id, nom: user.nom }, ramasseur: ramasseurCree };
    }),
});
