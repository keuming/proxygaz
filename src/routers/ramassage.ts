import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { and, eq, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { router, publicProcedure, protectedProcedure, requireRole } from "../trpc.js";
import { db, schema } from "../db/index.js";

const { demandesRamassage, ramasseurs, notifications } = schema;

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

    // Filtre applicatif par zone (commune/ville incluse dans zonesCouvertes)
    return demandes.filter(
      (d) => zones.includes(d.commune ?? "") || zones.includes(d.ville)
    );
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
        // Soit la demande n'existe pas, soit un autre ramasseur a été plus rapide
        throw new TRPCError({
          code: "CONFLICT",
          message: "Cette demande a déjà été prise par un autre ramasseur",
        });
      }

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
      const [profilRamasseur] = await db
        .select()
        .from(ramasseurs)
        .where(eq(ramasseurs.utilisateurId, ctx.user.id));

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
        })
        .from(demandesRamassage)
        .innerJoin(schema.utilisateurs, eq(demandesRamassage.clientId, schema.utilisateurs.id))
        .where(and(...conditions));

      const transactions = rows.map((r) => ({ ...r.demande, clientNom: r.clientNom }));

      const totalEspeces = transactions
        .filter((t) => t.modePaiement === "especes_livraison")
        .reduce((s, t) => s + Number(t.prixPropose ?? 0), 0);
      const totalMobilePay = transactions
        .filter((t) => t.modePaiement === "mobile_money")
        .reduce((s, t) => s + Number(t.prixPropose ?? 0), 0);

      return {
        transactions,
        totaux: {
          especes: totalEspeces,
          mobilePay: totalMobilePay,
          global: totalEspeces + totalMobilePay,
          nbTransactions: transactions.length,
        },
      };
    }),
});
