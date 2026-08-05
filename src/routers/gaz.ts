import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { and, eq, gt, desc, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { router, publicProcedure, protectedProcedure, requireRole } from "../trpc.js";
import { db, schema } from "../db/index.js";

const {
  commandesGaz,
  marquesGaz,
  boutiquesGaz,
  stockBoutique,
  livreurs,
  notifications,
  fournisseurs,
  approvisionnements,
  mouvementsStock,
  mouvementsCredit,
  demandesCredit,
  statutCommandeGazEnum,
} = schema;

/**
 * Enregistre un mouvement dans le registre de stock (traçabilité comptable).
 * `quantite` est signée : positive pour une entrée, négative pour une sortie.
 * Ne modifie pas le stock lui-même — c'est l'appelant qui gère la mise à jour de
 * stockBoutique.quantiteDisponible ; cette fonction se contente de journaliser.
 */
async function enregistrerMouvement(params: {
  boutiqueId: string;
  marqueGazId: string;
  typeMouvement: "entree_fournisseur" | "vente" | "ajustement" | "retour";
  quantite: number;
  soldeApres: number;
  reference?: string;
  notes?: string;
}) {
  await db.insert(mouvementsStock).values(params);
}

/**
 * Distance à vol d'oiseau entre deux points GPS (formule de Haversine), en kilomètres.
 * Suffisant pour trier "la boutique la plus proche" sans dépendre d'une API externe payante.
 */
function distanceKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371; // rayon moyen de la Terre en km
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export const gazRouter = router({
  // Liste des boutiques (façon "liste de restaurants") — triée par proximité réelle si les
  // coordonnées du client sont fournies, sinon par ville/commune.
  boutiquesProches: protectedProcedure
    .input(
      z
        .object({
          ville: z.string().optional(),
          commune: z.string().optional(),
          latitude: z.number().optional(),
          longitude: z.number().optional(),
        })
        .optional()
    )
    .query(async ({ input }) => {
      const conditions = [eq(boutiquesGaz.statutValidation, "valide")];
      if (input?.ville) conditions.push(eq(boutiquesGaz.ville, input.ville));
      if (input?.commune) conditions.push(eq(boutiquesGaz.commune, input.commune));

      const boutiques = await db
        .select()
        .from(boutiquesGaz)
        .where(and(...conditions));

      // Compte le nombre de références en stock par boutique, pour l'affichage façon "menu disponible"
      const stocks = await db
        .select({
          boutiqueId: stockBoutique.boutiqueId,
          nbReferences: sql<number>`count(*) filter (where ${stockBoutique.quantiteDisponible} > 0)`,
        })
        .from(stockBoutique)
        .groupBy(stockBoutique.boutiqueId);

      const stockParBoutique = new Map(stocks.map((s) => [s.boutiqueId, Number(s.nbReferences)]));

      const enrichies = boutiques.map((b) => {
        const distance =
          input?.latitude != null && input?.longitude != null && b.latitude != null && b.longitude != null
            ? distanceKm(input.latitude, input.longitude, b.latitude, b.longitude)
            : null;
        return {
          ...b,
          nbReferencesDisponibles: stockParBoutique.get(b.id) ?? 0,
          distanceKm: distance !== null ? Math.round(distance * 10) / 10 : null,
        };
      });

      // Tri par distance croissante si on la connaît, sinon ordre naturel
      enrichies.sort((a, b) => {
        if (a.distanceKm === null && b.distanceKm === null) return 0;
        if (a.distanceKm === null) return 1;
        if (b.distanceKm === null) return -1;
        return a.distanceKm - b.distanceKm;
      });

      return enrichies;
    }),

  // "Menu" d'une boutique : ses marques en stock avec prix et quantité (façon carte de restaurant)
  catalogueBoutique: protectedProcedure
    .input(z.object({ boutiqueId: z.string().uuid() }))
    .query(async ({ input }) => {
      const rows = await db
        .select({
          marqueId: marquesGaz.id,
          nom: marquesGaz.nom,
          taille: marquesGaz.taille,
          prixRecharge: marquesGaz.prixRecharge,
          prixConsigne: marquesGaz.prixConsigne,
          quantiteDisponible: stockBoutique.quantiteDisponible,
        })
        .from(stockBoutique)
        .innerJoin(marquesGaz, eq(stockBoutique.marqueGazId, marquesGaz.id))
        .where(and(eq(stockBoutique.boutiqueId, input.boutiqueId), gt(stockBoutique.quantiteDisponible, 0)));

      return rows;
    }),

  // Liste des marques/tailles disponibles (catalogue public, référentiel global)
  catalogue: publicProcedure.query(async () => {
    return db.select().from(marquesGaz).where(eq(marquesGaz.actif, true));
  }),

  // Catalogue enrichi de la disponibilité totale tous points de vente confondus —
  // utilisé pour la page "liste des produits" (parcours d'achat sans compte).
  catalogueDisponibilite: publicProcedure.query(async () => {
    const marques = await db.select().from(marquesGaz).where(eq(marquesGaz.actif, true));

    const disponibilites = await db
      .select({
        marqueGazId: stockBoutique.marqueGazId,
        totalDisponible: sql<number>`sum(${stockBoutique.quantiteDisponible})`,
        nbBoutiques: sql<number>`count(distinct ${stockBoutique.boutiqueId}) filter (where ${stockBoutique.quantiteDisponible} > 0)`,
      })
      .from(stockBoutique)
      .innerJoin(boutiquesGaz, eq(stockBoutique.boutiqueId, boutiquesGaz.id))
      .where(eq(boutiquesGaz.statutValidation, "valide"))
      .groupBy(stockBoutique.marqueGazId);

    const dispoParMarque = new Map(
      disponibilites.map((d) => [d.marqueGazId, { total: Number(d.totalDisponible), nbBoutiques: Number(d.nbBoutiques) }])
    );

    return marques.map((m) => ({
      ...m,
      totalDisponible: dispoParMarque.get(m.id)?.total ?? 0,
      nbBoutiques: dispoParMarque.get(m.id)?.nbBoutiques ?? 0,
    }));
  }),

  // Trouve les boutiques ayant du stock pour une marque donnée, proches du client
  boutiquesDisponibles: protectedProcedure
    .input(z.object({ marqueGazId: z.string().uuid() }))
    .query(async ({ input }) => {
      return db
        .select({
          boutique: boutiquesGaz,
          quantiteDisponible: stockBoutique.quantiteDisponible,
        })
        .from(stockBoutique)
        .innerJoin(boutiquesGaz, eq(stockBoutique.boutiqueId, boutiquesGaz.id))
        .where(
          and(
            eq(stockBoutique.marqueGazId, input.marqueGazId),
            gt(stockBoutique.quantiteDisponible, 0),
            eq(boutiquesGaz.statutValidation, "valide")
          )
        );
    }),

  // Créer une commande de bouteille de gaz — fonctionne connecté OU en tant qu'invité.
  // Si l'utilisateur n'est pas connecté, un compte client léger est créé silencieusement
  // (ou réutilisé s'il existe déjà pour ce numéro) afin de permettre le suivi ultérieur,
  // sans jamais imposer d'écran d'inscription au client.
  creerCommande: publicProcedure
    .input(
      z.object({
        marqueGazId: z.string().uuid(),
        boutiqueId: z.string().uuid().optional(), // si non fourni, assignation auto à la première boutique en stock
        quantite: z.number().int().min(1).default(1),
        echangeBouteilleVide: z.boolean().default(true),
        adresseLivraison: z.string().min(5),
        latitude: z.number().optional(),
        longitude: z.number().optional(),
        notes: z.string().optional(),
        modePaiement: z.enum(["mobile_money", "especes_livraison"]).optional(),
        // Renseignés uniquement si la personne n'est pas déjà connectée
        nomClient: z.string().min(2).optional(),
        telephoneClient: z.string().min(8).optional(),
        motDePasseClient: z.string().min(6).optional(), // optionnel : pour créer un vrai compte
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
            message: "Nom et téléphone requis pour commander sans compte",
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
          const motDePasseHash = await bcrypt.hash(
            input.motDePasseClient ?? randomUUID(),
            10
          );

          const [nouveauClient] = await db
            .insert(schema.utilisateurs)
            .values({
              nom: input.nomClient,
              telephone: input.telephoneClient,
              motDePasseHash,
              role: "client",
            })
            .returning();
          clientId = nouveauClient.id;
        }

        // Génère un jeton de session pour que le suivi de commande fonctionne
        // immédiatement après, sans que la personne ait eu à se connecter.
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

      const [marque] = await db
        .select()
        .from(marquesGaz)
        .where(eq(marquesGaz.id, input.marqueGazId));

      if (!marque) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Marque de gaz introuvable" });
      }

      // Assignation automatique à la boutique la plus proche disposant du stock (si coordonnées
      // fournies), sinon à la première trouvée, si aucune boutique n'a été précisée explicitement.
      let boutiqueId = input.boutiqueId;
      if (!boutiqueId) {
        const candidates = await db
          .select({
            id: boutiquesGaz.id,
            latitude: boutiquesGaz.latitude,
            longitude: boutiquesGaz.longitude,
          })
          .from(stockBoutique)
          .innerJoin(boutiquesGaz, eq(stockBoutique.boutiqueId, boutiquesGaz.id))
          .where(
            and(
              eq(stockBoutique.marqueGazId, input.marqueGazId),
              gt(stockBoutique.quantiteDisponible, 0),
              eq(boutiquesGaz.statutValidation, "valide")
            )
          );

        if (candidates.length === 0) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "Aucune boutique n'a ce produit en stock actuellement",
          });
        }

        if (input.latitude != null && input.longitude != null) {
          const avecDistance = candidates
            .map((c) => ({
              id: c.id,
              distance:
                c.latitude != null && c.longitude != null
                  ? distanceKm(input.latitude!, input.longitude!, c.latitude, c.longitude)
                  : Infinity,
            }))
            .sort((a, b) => a.distance - b.distance);
          boutiqueId = avecDistance[0].id;
        } else {
          boutiqueId = candidates[0].id;
        }
      }

      const prixUnitaire = parseFloat(marque.prixRecharge);
      const prixTotal = prixUnitaire * input.quantite;

      // Le mobile money est considéré encaissé dès la confirmation du paiement au checkout ;
      // les espèces ne sont encaissées qu'à la livraison effective (voir marquerLivree).
      const encaisseImmediatement = input.modePaiement === "mobile_money";

      const [commande] = await db
        .insert(commandesGaz)
        .values({
          clientId,
          marqueGazId: input.marqueGazId,
          boutiqueId,
          quantite: input.quantite,
          echangeBouteilleVide: input.echangeBouteilleVide,
          adresseLivraison: input.adresseLivraison,
          latitude: input.latitude,
          longitude: input.longitude,
          prixTotal: prixTotal.toString(),
          notes: input.notes,
          modePaiement: input.modePaiement,
          encaisse: encaisseImmediatement,
          encaisseAt: encaisseImmediatement ? new Date() : undefined,
          statut: "en_attente",
        })
        .returning();

      return { commande, token: tokenGenere, user: userGenere };
    }),

  // La boutique confirme la commande et décrémente son stock (transaction atomique)
  confirmerCommande: requireRole("boutique", "admin")
    .input(z.object({ commandeId: z.string().uuid() }))
    .mutation(async ({ input }) => {
      const [commande] = await db
        .select()
        .from(commandesGaz)
        .where(eq(commandesGaz.id, input.commandeId));

      if (!commande || commande.statut !== "en_attente") {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Commande introuvable ou déjà traitée",
        });
      }

      // Décrémentation atomique du stock, protégée contre le passage en négatif
      const [stockMisAJour] = await db
        .update(stockBoutique)
        .set({
          quantiteDisponible: sql`${stockBoutique.quantiteDisponible} - ${commande.quantite}`,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(stockBoutique.boutiqueId, commande.boutiqueId!),
            eq(stockBoutique.marqueGazId, commande.marqueGazId),
            gt(stockBoutique.quantiteDisponible, commande.quantite - 1)
          )
        )
        .returning();

      if (!stockMisAJour) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "Stock insuffisant pour confirmer cette commande",
        });
      }

      await enregistrerMouvement({
        boutiqueId: commande.boutiqueId!,
        marqueGazId: commande.marqueGazId,
        typeMouvement: "vente",
        quantite: -commande.quantite,
        soldeApres: stockMisAJour.quantiteDisponible,
        reference: commande.id,
        notes: `Commande confirmée`,
      });

      const [commandeConfirmee] = await db
        .update(commandesGaz)
        .set({ statut: "confirmee", confirmedAt: new Date() })
        .where(eq(commandesGaz.id, input.commandeId))
        .returning();

      await db.insert(notifications).values({
        utilisateurId: commande.clientId,
        titre: "Commande confirmée",
        message: "Votre bouteille de gaz est en cours de préparation pour livraison.",
        type: "commande_gaz",
      });

      return commandeConfirmee;
    }),

  // Transition confirmee -> en_livraison, DÉCLENCHÉE PAR L'ADMIN/LA BOUTIQUE (assignation manuelle)
  demarrerLivraison: requireRole("boutique", "admin")
    .input(z.object({ commandeId: z.string().uuid(), livreurNom: z.string().optional(), livreurTelephone: z.string().optional() }))
    .mutation(async ({ input }) => {
      const [commande] = await db
        .update(commandesGaz)
        .set({
          statut: "en_livraison",
          livreurNom: input.livreurNom,
          livreurTelephone: input.livreurTelephone,
        })
        .where(and(eq(commandesGaz.id, input.commandeId), eq(commandesGaz.statut, "confirmee")))
        .returning();

      if (!commande) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "La commande doit être confirmée avant de démarrer la livraison",
        });
      }

      return commande;
    }),

  // Livraisons disponibles pour un livreur (commandes confirmées, dans sa zone, pas encore prises)
  livraisonsDisponibles: requireRole("livreur").query(async ({ ctx }) => {
    const [profilLivreur] = await db
      .select()
      .from(livreurs)
      .where(eq(livreurs.utilisateurId, ctx.user.id));

    if (!profilLivreur) {
      throw new TRPCError({ code: "NOT_FOUND", message: "Profil livreur introuvable" });
    }

    const zones = profilLivreur.zonesCouvertes as string[];

    const rows = await db
      .select({
        commande: commandesGaz,
        boutiqueNom: boutiquesGaz.nomBoutique,
        boutiqueVille: boutiquesGaz.ville,
        boutiqueCommune: boutiquesGaz.commune,
        boutiqueAdresse: boutiquesGaz.adresse,
        boutiqueLat: boutiquesGaz.latitude,
        boutiqueLng: boutiquesGaz.longitude,
      })
      .from(commandesGaz)
      .innerJoin(boutiquesGaz, eq(commandesGaz.boutiqueId, boutiquesGaz.id))
      .where(eq(commandesGaz.statut, "confirmee"));

    // Position à utiliser pour le calcul de proximité : la position GPS en direct si connue
    // (mise à jour en continu pendant que le livreur est actif), sinon sa position d'inscription.
    const latRef = profilLivreur.positionActuelleLat ?? profilLivreur.latitude;
    const lngRef = profilLivreur.positionActuelleLng ?? profilLivreur.longitude;

    const resultats = rows
      .filter((r) => zones.includes(r.boutiqueCommune ?? "") || zones.includes(r.boutiqueVille))
      .map((r) => {
        const distance =
          latRef != null && lngRef != null && r.boutiqueLat != null && r.boutiqueLng != null
            ? distanceKm(latRef, lngRef, r.boutiqueLat, r.boutiqueLng)
            : null;
        return {
          ...r.commande,
          boutiqueNom: r.boutiqueNom,
          boutiqueVille: r.boutiqueVille,
          boutiqueCommune: r.boutiqueCommune,
          boutiqueAdresse: r.boutiqueAdresse,
          distanceKm: distance !== null ? Math.round(distance * 10) / 10 : null,
        };
      });

    // Les plus proches en premier ; celles sans position connue passent en dernier
    resultats.sort((a, b) => {
      if (a.distanceKm === null && b.distanceKm === null) return 0;
      if (a.distanceKm === null) return 1;
      if (b.distanceKm === null) return -1;
      return a.distanceKm - b.distanceKm;
    });

    return resultats;
  }),

  // Le livreur transmet sa position GPS en direct pendant qu'il est actif, pour que les
  // courses disponibles lui soient présentées triées par proximité réelle.
  majPositionLivreur: requireRole("livreur")
    .input(z.object({ latitude: z.number(), longitude: z.number() }))
    .mutation(async ({ ctx, input }) => {
      const [profilLivreur] = await db
        .select()
        .from(livreurs)
        .where(eq(livreurs.utilisateurId, ctx.user.id));
      if (!profilLivreur) throw new TRPCError({ code: "NOT_FOUND", message: "Profil livreur introuvable" });

      await db
        .update(livreurs)
        .set({
          positionActuelleLat: input.latitude,
          positionActuelleLng: input.longitude,
          positionMajAt: new Date(),
        })
        .where(eq(livreurs.id, profilLivreur.id));

      return { ok: true };
    }),

  /**
   * ACCEPTATION D'UNE LIVRAISON - "premier qui accepte, gagne"
   * Même pattern atomique que ramassage.validerDemande : UPDATE conditionné sur le
   * statut actuel pour éviter la course entre plusieurs livreurs.
   */
  accepterLivraison: requireRole("livreur")
    .input(z.object({ commandeId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const [profilLivreur] = await db
        .select()
        .from(livreurs)
        .where(eq(livreurs.utilisateurId, ctx.user.id));

      if (!profilLivreur || profilLivreur.statutValidation !== "valide") {
        throw new TRPCError({ code: "FORBIDDEN", message: "Profil livreur non validé" });
      }

      // Frais de service ProxiGaz : 1 crédit (100 FCFA) réservé avant d'accepter la course.
      // Débit atomique conditionné sur credits > 0, pour éviter tout passage en négatif
      // en cas d'acceptations concurrentes.
      const [livreurDebite] = await db
        .update(livreurs)
        .set({ credits: sql`${livreurs.credits} - 1` })
        .where(and(eq(livreurs.id, profilLivreur.id), gt(livreurs.credits, 0)))
        .returning();

      if (!livreurDebite) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Crédit insuffisant. Achetez des crédits pour accepter des courses.",
        });
      }

      const [utilisateurLivreur] = await db
        .select({ nom: schema.utilisateurs.nom, telephone: schema.utilisateurs.telephone })
        .from(schema.utilisateurs)
        .where(eq(schema.utilisateurs.id, ctx.user.id));

      const [commande] = await db
        .update(commandesGaz)
        .set({
          statut: "en_livraison",
          livreurId: profilLivreur.id,
          livreurNom: utilisateurLivreur?.nom,
          livreurTelephone: utilisateurLivreur?.telephone,
        })
        .where(and(eq(commandesGaz.id, input.commandeId), eq(commandesGaz.statut, "confirmee")))
        .returning();

      if (!commande) {
        // La course a été prise entretemps par un autre livreur : on rembourse le crédit réservé.
        const [rembourse] = await db
          .update(livreurs)
          .set({ credits: sql`${livreurs.credits} + 1` })
          .where(eq(livreurs.id, profilLivreur.id))
          .returning();

        await db.insert(mouvementsCredit).values({
          livreurId: profilLivreur.id,
          typeMouvement: "ajustement",
          quantite: 1,
          soldeApres: rembourse.credits,
          reference: input.commandeId,
          notes: "Remboursement : course déjà prise par un autre livreur",
        });

        throw new TRPCError({
          code: "CONFLICT",
          message: "Cette livraison a déjà été prise par un autre livreur",
        });
      }

      await db.insert(mouvementsCredit).values({
        livreurId: profilLivreur.id,
        typeMouvement: "debit_livraison",
        quantite: -1,
        soldeApres: livreurDebite.credits,
        reference: commande.id,
        notes: "Frais de service ProxiGaz (100 FCFA)",
      });

      await db.insert(notifications).values({
        utilisateurId: commande.clientId,
        titre: "Livreur en route",
        message: "Un livreur a accepté votre commande et est en route.",
        type: "commande_gaz",
      });

      return commande;
    }),

  marquerLivree: requireRole("boutique", "admin", "livreur")
    .input(z.object({ commandeId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      let filtreProprietaire = undefined;

      if (ctx.user.role === "livreur") {
        const [profilLivreur] = await db
          .select()
          .from(livreurs)
          .where(eq(livreurs.utilisateurId, ctx.user.id));

        if (!profilLivreur) {
          throw new TRPCError({ code: "FORBIDDEN", message: "Profil livreur introuvable" });
        }
        filtreProprietaire = eq(commandesGaz.livreurId, profilLivreur.id);
      }

      const [commande] = await db
        .update(commandesGaz)
        .set({
          statut: "livree",
          livreeAt: new Date(),
          // Les espèces sont encaissées à cet instant précis (remise en main propre au livreur/boutique) ;
          // le mobile money était déjà marqué encaissé au moment du paiement simulé au checkout.
          encaisse: sql`CASE WHEN ${commandesGaz.modePaiement} = 'especes_livraison' THEN true ELSE ${commandesGaz.encaisse} END`,
          encaisseAt: sql`CASE WHEN ${commandesGaz.modePaiement} = 'especes_livraison' AND ${commandesGaz.encaisse} = false THEN now() ELSE ${commandesGaz.encaisseAt} END`,
        })
        .where(
          and(
            eq(commandesGaz.id, input.commandeId),
            eq(commandesGaz.statut, "en_livraison"),
            filtreProprietaire
          )
        )
        .returning();

      if (!commande) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Transition de statut invalide ou commande non attribuée à ce livreur",
        });
      }

      // Incrémente le compteur de livraisons du livreur si applicable
      if (commande.livreurId) {
        await db
          .update(livreurs)
          .set({ nombreLivraisons: sql`${livreurs.nombreLivraisons} + 1` })
          .where(eq(livreurs.id, commande.livreurId));
      }

      return commande;
    }),

  // Livraison tentée mais échouée (client absent, adresse erronée, refus...)
  marquerNonLivree: requireRole("boutique", "admin", "livreur")
    .input(z.object({ commandeId: z.string().uuid(), raison: z.string().min(3) }))
    .mutation(async ({ ctx, input }) => {
      let filtreProprietaire = undefined;

      if (ctx.user.role === "livreur") {
        const [profilLivreur] = await db
          .select()
          .from(livreurs)
          .where(eq(livreurs.utilisateurId, ctx.user.id));
        if (!profilLivreur) {
          throw new TRPCError({ code: "FORBIDDEN", message: "Profil livreur introuvable" });
        }
        filtreProprietaire = eq(commandesGaz.livreurId, profilLivreur.id);
      }

      const [commande] = await db
        .update(commandesGaz)
        .set({ statut: "non_livree", raisonNonLivraison: input.raison })
        .where(
          and(
            eq(commandesGaz.id, input.commandeId),
            eq(commandesGaz.statut, "en_livraison"),
            filtreProprietaire
          )
        )
        .returning();

      if (!commande) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Transition de statut invalide ou commande non attribuée",
        });
      }

      await db.insert(notifications).values({
        utilisateurId: commande.clientId,
        titre: "Livraison non aboutie",
        message: `Votre commande n'a pas pu être livrée : ${input.raison}`,
        type: "commande_gaz",
      });

      return commande;
    }),

  // Annulation (client sur sa propre commande en_attente, ou boutique/admin à tout moment avant livraison)
  annulerCommande: protectedProcedure
    .input(z.object({ commandeId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const [commande] = await db
        .select()
        .from(commandesGaz)
        .where(eq(commandesGaz.id, input.commandeId));

      if (!commande) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Commande introuvable" });
      }

      const estProprietaire = commande.clientId === ctx.user.id;
      const estGestionnaire = ["boutique", "admin"].includes(ctx.user.role);
      if (!estProprietaire && !estGestionnaire) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Action non autorisée" });
      }

      if (!["en_attente", "confirmee"].includes(commande.statut)) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Cette commande ne peut plus être annulée (déjà en livraison ou terminée)",
        });
      }

      // Si le stock avait été décrémenté (commande confirmée), on le restitue
      if (commande.statut === "confirmee" && commande.boutiqueId) {
        const [stockRestitue] = await db
          .update(stockBoutique)
          .set({
            quantiteDisponible: sql`${stockBoutique.quantiteDisponible} + ${commande.quantite}`,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(stockBoutique.boutiqueId, commande.boutiqueId),
              eq(stockBoutique.marqueGazId, commande.marqueGazId)
            )
          )
          .returning();

        if (stockRestitue) {
          await enregistrerMouvement({
            boutiqueId: commande.boutiqueId,
            marqueGazId: commande.marqueGazId,
            typeMouvement: "retour",
            quantite: commande.quantite,
            soldeApres: stockRestitue.quantiteDisponible,
            reference: commande.id,
            notes: "Commande annulée après confirmation, stock restitué",
          });
        }
      }

      const [commandeAnnulee] = await db
        .update(commandesGaz)
        .set({ statut: "annulee" })
        .where(eq(commandesGaz.id, input.commandeId))
        .returning();

      return commandeAnnulee;
    }),

  mesCommandes: protectedProcedure.query(async ({ ctx }) => {
    return db
      .select()
      .from(commandesGaz)
      .where(eq(commandesGaz.clientId, ctx.user.id));
  }),

  // ---- Espace boutique (self-service) ----

  commandesBoutique: requireRole("boutique")
    .input(z.object({ statut: z.enum(statutCommandeGazEnum.enumValues).optional() }).optional())
    .query(async ({ ctx, input }) => {
      const [boutique] = await db
        .select()
        .from(boutiquesGaz)
        .where(eq(boutiquesGaz.utilisateurId, ctx.user.id));

      if (!boutique) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Profil boutique introuvable" });
      }

      const rows = await db
        .select({
          commande: commandesGaz,
          clientNom: schema.utilisateurs.nom,
          clientTelephone: schema.utilisateurs.telephone,
        })
        .from(commandesGaz)
        .innerJoin(schema.utilisateurs, eq(commandesGaz.clientId, schema.utilisateurs.id))
        .where(
          input?.statut
            ? and(eq(commandesGaz.boutiqueId, boutique.id), eq(commandesGaz.statut, input.statut))
            : eq(commandesGaz.boutiqueId, boutique.id)
        )
        .orderBy(desc(commandesGaz.createdAt));

      return rows.map((r) => ({ ...r.commande, clientNom: r.clientNom, clientTelephone: r.clientTelephone }));
    }),

  // Profil de la boutique du gérant connecté — utilisé notamment pour personnaliser
  // l'en-tête du dashboard avec le vrai nom de la boutique plutôt qu'un libellé générique.
  monProfilBoutique: requireRole("boutique").query(async ({ ctx }) => {
    const [boutique] = await db
      .select()
      .from(boutiquesGaz)
      .where(eq(boutiquesGaz.utilisateurId, ctx.user.id));

    if (!boutique) {
      throw new TRPCError({ code: "NOT_FOUND", message: "Profil boutique introuvable" });
    }
    return boutique;
  }),

  monStock: requireRole("boutique").query(async ({ ctx }) => {
    const [boutique] = await db
      .select()
      .from(boutiquesGaz)
      .where(eq(boutiquesGaz.utilisateurId, ctx.user.id));

    if (!boutique) {
      throw new TRPCError({ code: "NOT_FOUND", message: "Profil boutique introuvable" });
    }

    const rows = await db
      .select({
        stock: stockBoutique,
        marqueNom: marquesGaz.nom,
        marqueTaille: marquesGaz.taille,
      })
      .from(stockBoutique)
      .innerJoin(marquesGaz, eq(stockBoutique.marqueGazId, marquesGaz.id))
      .where(eq(stockBoutique.boutiqueId, boutique.id));

    return rows.map((r) => ({ ...r.stock, marqueNom: r.marqueNom, marqueTaille: r.marqueTaille }));
  }),

  majMonStock: requireRole("boutique")
    .input(
      z.object({
        marqueGazId: z.string().uuid(),
        quantiteDisponible: z.number().int().nonnegative(),
        seuilAlerte: z.number().int().nonnegative().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const [boutique] = await db
        .select()
        .from(boutiquesGaz)
        .where(eq(boutiquesGaz.utilisateurId, ctx.user.id));

      if (!boutique) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Profil boutique introuvable" });
      }

      const [existant] = await db
        .select()
        .from(stockBoutique)
        .where(
          and(
            eq(stockBoutique.boutiqueId, boutique.id),
            eq(stockBoutique.marqueGazId, input.marqueGazId)
          )
        );

      if (existant) {
        const ecart = input.quantiteDisponible - existant.quantiteDisponible;
        const [maj] = await db
          .update(stockBoutique)
          .set({
            quantiteDisponible: input.quantiteDisponible,
            seuilAlerte: input.seuilAlerte ?? existant.seuilAlerte,
            updatedAt: new Date(),
          })
          .where(eq(stockBoutique.id, existant.id))
          .returning();

        if (ecart !== 0) {
          await enregistrerMouvement({
            boutiqueId: boutique.id,
            marqueGazId: input.marqueGazId,
            typeMouvement: "ajustement",
            quantite: ecart,
            soldeApres: input.quantiteDisponible,
            notes: "Ajustement manuel d'inventaire",
          });
        }
        return maj;
      }

      const [créé] = await db
        .insert(stockBoutique)
        .values({
          boutiqueId: boutique.id,
          marqueGazId: input.marqueGazId,
          quantiteDisponible: input.quantiteDisponible,
          seuilAlerte: input.seuilAlerte ?? 5,
        })
        .returning();

      if (input.quantiteDisponible > 0) {
        await enregistrerMouvement({
          boutiqueId: boutique.id,
          marqueGazId: input.marqueGazId,
          typeMouvement: "ajustement",
          quantite: input.quantiteDisponible,
          soldeApres: input.quantiteDisponible,
          notes: "Stock initial",
        });
      }

      return créé;
    }),

  // ---- Fournisseurs (self-service boutique) ----

  mesFournisseurs: requireRole("boutique").query(async ({ ctx }) => {
    const [boutique] = await db
      .select()
      .from(boutiquesGaz)
      .where(eq(boutiquesGaz.utilisateurId, ctx.user.id));
    if (!boutique) throw new TRPCError({ code: "NOT_FOUND", message: "Profil boutique introuvable" });

    return db
      .select()
      .from(fournisseurs)
      .where(eq(fournisseurs.boutiqueId, boutique.id))
      .orderBy(desc(fournisseurs.createdAt));
  }),

  creerFournisseur: requireRole("boutique")
    .input(
      z.object({
        nom: z.string().min(2),
        telephone: z.string().optional(),
        adresse: z.string().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const [boutique] = await db
        .select()
        .from(boutiquesGaz)
        .where(eq(boutiquesGaz.utilisateurId, ctx.user.id));
      if (!boutique) throw new TRPCError({ code: "NOT_FOUND", message: "Profil boutique introuvable" });

      const [fournisseur] = await db
        .insert(fournisseurs)
        .values({ boutiqueId: boutique.id, nom: input.nom, telephone: input.telephone, adresse: input.adresse })
        .returning();
      return fournisseur;
    }),

  // ---- Approvisionnements (bons de commande fournisseur) ----

  mesApprovisionnements: requireRole("boutique").query(async ({ ctx }) => {
    const [boutique] = await db
      .select()
      .from(boutiquesGaz)
      .where(eq(boutiquesGaz.utilisateurId, ctx.user.id));
    if (!boutique) throw new TRPCError({ code: "NOT_FOUND", message: "Profil boutique introuvable" });

    const rows = await db
      .select({
        appro: approvisionnements,
        fournisseurNom: fournisseurs.nom,
        marqueNom: marquesGaz.nom,
        marqueTaille: marquesGaz.taille,
      })
      .from(approvisionnements)
      .innerJoin(fournisseurs, eq(approvisionnements.fournisseurId, fournisseurs.id))
      .innerJoin(marquesGaz, eq(approvisionnements.marqueGazId, marquesGaz.id))
      .where(eq(approvisionnements.boutiqueId, boutique.id))
      .orderBy(desc(approvisionnements.dateCommande));

    return rows.map((r) => ({
      ...r.appro,
      fournisseurNom: r.fournisseurNom,
      marqueNom: r.marqueNom,
      marqueTaille: r.marqueTaille,
    }));
  }),

  creerApprovisionnement: requireRole("boutique")
    .input(
      z.object({
        fournisseurId: z.string().uuid(),
        marqueGazId: z.string().uuid(),
        quantite: z.number().int().positive(),
        prixAchatUnitaire: z.number().nonnegative().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const [boutique] = await db
        .select()
        .from(boutiquesGaz)
        .where(eq(boutiquesGaz.utilisateurId, ctx.user.id));
      if (!boutique) throw new TRPCError({ code: "NOT_FOUND", message: "Profil boutique introuvable" });

      const [appro] = await db
        .insert(approvisionnements)
        .values({
          boutiqueId: boutique.id,
          fournisseurId: input.fournisseurId,
          marqueGazId: input.marqueGazId,
          quantite: input.quantite,
          prixAchatUnitaire: input.prixAchatUnitaire?.toString(),
          statut: "commande",
        })
        .returning();
      return appro;
    }),

  // Réception d'un bon de commande : incrémente le stock et journalise l'entrée
  receptionnerApprovisionnement: requireRole("boutique")
    .input(z.object({ approvisionnementId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const [boutique] = await db
        .select()
        .from(boutiquesGaz)
        .where(eq(boutiquesGaz.utilisateurId, ctx.user.id));
      if (!boutique) throw new TRPCError({ code: "NOT_FOUND", message: "Profil boutique introuvable" });

      const [appro] = await db
        .update(approvisionnements)
        .set({ statut: "receptionne", dateReception: new Date() })
        .where(
          and(
            eq(approvisionnements.id, input.approvisionnementId),
            eq(approvisionnements.boutiqueId, boutique.id),
            eq(approvisionnements.statut, "commande")
          )
        )
        .returning();

      if (!appro) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Bon de commande introuvable ou déjà réceptionné",
        });
      }

      const [existant] = await db
        .select()
        .from(stockBoutique)
        .where(
          and(
            eq(stockBoutique.boutiqueId, boutique.id),
            eq(stockBoutique.marqueGazId, appro.marqueGazId)
          )
        );

      let nouveauSolde: number;
      if (existant) {
        const [maj] = await db
          .update(stockBoutique)
          .set({
            quantiteDisponible: sql`${stockBoutique.quantiteDisponible} + ${appro.quantite}`,
            updatedAt: new Date(),
          })
          .where(eq(stockBoutique.id, existant.id))
          .returning();
        nouveauSolde = maj.quantiteDisponible;
      } else {
        const [créé] = await db
          .insert(stockBoutique)
          .values({
            boutiqueId: boutique.id,
            marqueGazId: appro.marqueGazId,
            quantiteDisponible: appro.quantite,
          })
          .returning();
        nouveauSolde = créé.quantiteDisponible;
      }

      await enregistrerMouvement({
        boutiqueId: boutique.id,
        marqueGazId: appro.marqueGazId,
        typeMouvement: "entree_fournisseur",
        quantite: appro.quantite,
        soldeApres: nouveauSolde,
        reference: appro.id,
        notes: "Réception d'un bon de commande fournisseur",
      });

      return appro;
    }),

  // ---- Registre des mouvements de stock (traçabilité, façon inventaire) ----

  monHistoriqueStock: requireRole("boutique").query(async ({ ctx }) => {
    const [boutique] = await db
      .select()
      .from(boutiquesGaz)
      .where(eq(boutiquesGaz.utilisateurId, ctx.user.id));
    if (!boutique) throw new TRPCError({ code: "NOT_FOUND", message: "Profil boutique introuvable" });

    const rows = await db
      .select({
        mouvement: mouvementsStock,
        marqueNom: marquesGaz.nom,
        marqueTaille: marquesGaz.taille,
      })
      .from(mouvementsStock)
      .innerJoin(marquesGaz, eq(mouvementsStock.marqueGazId, marquesGaz.id))
      .where(eq(mouvementsStock.boutiqueId, boutique.id))
      .orderBy(desc(mouvementsStock.createdAt))
      .limit(200);

    return rows.map((r) => ({ ...r.mouvement, marqueNom: r.marqueNom, marqueTaille: r.marqueTaille }));
  }),

  // ---- Encaissements (fenêtre de monitoring caisse : espèces vs MobilePay) ----

  mesEncaissements: requireRole("boutique")
    .input(
      z
        .object({
          depuis: z.string().datetime().optional(), // ISO 8601, filtre optionnel sur encaisseAt
        })
        .optional()
    )
    .query(async ({ ctx, input }) => {
      const boutiqueRows = await db
        .select({
          boutique: boutiquesGaz,
          boutiqueTelephone: schema.utilisateurs.telephone,
        })
        .from(boutiquesGaz)
        .innerJoin(schema.utilisateurs, eq(boutiquesGaz.utilisateurId, schema.utilisateurs.id))
        .where(eq(boutiquesGaz.utilisateurId, ctx.user.id));

      const boutique = boutiqueRows[0]
        ? { ...boutiqueRows[0].boutique, telephone: boutiqueRows[0].boutiqueTelephone }
        : null;

      if (!boutique) throw new TRPCError({ code: "NOT_FOUND", message: "Profil boutique introuvable" });

      const conditions = [eq(commandesGaz.boutiqueId, boutique.id), eq(commandesGaz.encaisse, true)];
      if (input?.depuis) {
        conditions.push(sql`${commandesGaz.encaisseAt} >= ${input.depuis}::timestamp`);
      }

      const rows = await db
        .select({
          commande: commandesGaz,
          clientNom: schema.utilisateurs.nom,
          clientTelephone: schema.utilisateurs.telephone,
        })
        .from(commandesGaz)
        .innerJoin(schema.utilisateurs, eq(commandesGaz.clientId, schema.utilisateurs.id))
        .where(and(...conditions))
        .orderBy(desc(commandesGaz.encaisseAt));

      const transactions = rows.map((r) => ({
        ...r.commande,
        clientNom: r.clientNom,
        clientTelephone: r.clientTelephone,
      }));

      const totalEspeces = transactions
        .filter((t) => t.modePaiement === "especes_livraison")
        .reduce((s, t) => s + Number(t.prixTotal), 0);
      const totalMobilePay = transactions
        .filter((t) => t.modePaiement === "mobile_money")
        .reduce((s, t) => s + Number(t.prixTotal), 0);

      return {
        boutique: { nom: boutique.nomBoutique, telephone: boutique.telephone },
        transactions,
        totaux: {
          especes: totalEspeces,
          mobilePay: totalMobilePay,
          global: totalEspeces + totalMobilePay,
          nbTransactions: transactions.length,
        },
      };
    }),

  // ---- Espace livreur (self-service) ----

  mesLivraisons: requireRole("livreur").query(async ({ ctx }) => {
    const [profilLivreur] = await db
      .select()
      .from(livreurs)
      .where(eq(livreurs.utilisateurId, ctx.user.id));

    if (!profilLivreur) {
      throw new TRPCError({ code: "NOT_FOUND", message: "Profil livreur introuvable" });
    }

    return db
      .select()
      .from(commandesGaz)
      .where(eq(commandesGaz.livreurId, profilLivreur.id));
  }),

  statsLivreur: requireRole("livreur").query(async ({ ctx }) => {
    const [profilLivreur] = await db
      .select()
      .from(livreurs)
      .where(eq(livreurs.utilisateurId, ctx.user.id));

    if (!profilLivreur) {
      throw new TRPCError({ code: "NOT_FOUND", message: "Profil livreur introuvable" });
    }

    const debutMois = new Date();
    debutMois.setDate(1);
    debutMois.setHours(0, 0, 0, 0);

    const toutes = await db
      .select()
      .from(commandesGaz)
      .where(eq(commandesGaz.livreurId, profilLivreur.id));

    const livrees = toutes.filter((c) => c.statut === "livree");
    const livreesCeMois = livrees.filter((c) => c.livreeAt && c.livreeAt >= debutMois);
    const nonLivrees = toutes.filter((c) => c.statut === "non_livree");

    return {
      totalLivraisons: livrees.length,
      livraisonsCeMois: livreesCeMois.length,
      valeurLivreeCeMois: livreesCeMois.reduce((s, c) => s + Number(c.prixTotal), 0),
      tauxReussite:
        livrees.length + nonLivrees.length > 0
          ? Math.round((livrees.length / (livrees.length + nonLivrees.length)) * 100)
          : 100,
      enCoursActuellement: toutes.filter((c) => c.statut === "en_livraison").length,
    };
  }),

  // ---- Système de crédit (frais de service : 1 crédit = 100 FCFA / course acceptée) ----

  mesCreditsLivreur: requireRole("livreur").query(async ({ ctx }) => {
    const [profilLivreur] = await db
      .select()
      .from(livreurs)
      .where(eq(livreurs.utilisateurId, ctx.user.id));
    if (!profilLivreur) throw new TRPCError({ code: "NOT_FOUND", message: "Profil livreur introuvable" });
    return { credits: profilLivreur.credits };
  }),

  mesMouvementsCreditLivreur: requireRole("livreur").query(async ({ ctx }) => {
    const [profilLivreur] = await db
      .select()
      .from(livreurs)
      .where(eq(livreurs.utilisateurId, ctx.user.id));
    if (!profilLivreur) throw new TRPCError({ code: "NOT_FOUND", message: "Profil livreur introuvable" });

    return db
      .select()
      .from(mouvementsCredit)
      .where(eq(mouvementsCredit.livreurId, profilLivreur.id))
      .orderBy(desc(mouvementsCredit.createdAt))
      .limit(100);
  }),

  mesDemandesCreditLivreur: requireRole("livreur").query(async ({ ctx }) => {
    const [profilLivreur] = await db
      .select()
      .from(livreurs)
      .where(eq(livreurs.utilisateurId, ctx.user.id));
    if (!profilLivreur) throw new TRPCError({ code: "NOT_FOUND", message: "Profil livreur introuvable" });

    return db
      .select()
      .from(demandesCredit)
      .where(eq(demandesCredit.livreurId, profilLivreur.id))
      .orderBy(desc(demandesCredit.createdAt));
  }),

  // Le livreur envoie une demande d'achat de crédit après un paiement MobilePay simulé.
  // La mise à disposition effective (incrémentation du solde) se fait par l'admin.
  demanderCreditLivreur: requireRole("livreur")
    .input(
      z.object({
        quantiteCredits: z.number().int().positive(),
        referencePaiement: z.string().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const [profilLivreur] = await db
        .select()
        .from(livreurs)
        .where(eq(livreurs.utilisateurId, ctx.user.id));
      if (!profilLivreur) throw new TRPCError({ code: "NOT_FOUND", message: "Profil livreur introuvable" });

      const [demande] = await db
        .insert(demandesCredit)
        .values({
          livreurId: profilLivreur.id,
          quantiteCredits: input.quantiteCredits,
          montantPaye: (input.quantiteCredits * 100).toString(),
          modePaiement: "mobile_money",
          referencePaiement: input.referencePaiement,
          statut: "en_attente",
        })
        .returning();

      return demande;
    }),
});
