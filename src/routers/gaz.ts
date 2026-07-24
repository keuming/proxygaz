import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { and, eq, gt, desc, sql } from "drizzle-orm";
import { router, protectedProcedure, requireRole } from "../trpc.js";
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

export const gazRouter = router({
  // Liste des boutiques (façon "liste de restaurants") — parcours en premier, avant de choisir un produit
  boutiquesProches: protectedProcedure
    .input(z.object({ ville: z.string().optional(), commune: z.string().optional() }).optional())
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

      return boutiques.map((b) => ({
        ...b,
        nbReferencesDisponibles: stockParBoutique.get(b.id) ?? 0,
      }));
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
  catalogue: protectedProcedure.query(async () => {
    return db.select().from(marquesGaz).where(eq(marquesGaz.actif, true));
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

  // Créer une commande de bouteille de gaz
  creerCommande: protectedProcedure
    .input(
      z.object({
        marqueGazId: z.string().uuid(),
        boutiqueId: z.string().uuid().optional(), // si non fourni, assignation auto par proximité (TODO)
        quantite: z.number().int().min(1).default(1),
        echangeBouteilleVide: z.boolean().default(true),
        adresseLivraison: z.string().min(5),
        latitude: z.number().optional(),
        longitude: z.number().optional(),
        notes: z.string().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const [marque] = await db
        .select()
        .from(marquesGaz)
        .where(eq(marquesGaz.id, input.marqueGazId));

      if (!marque) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Marque de gaz introuvable" });
      }

      const prixUnitaire = parseFloat(marque.prixRecharge);
      const prixTotal = prixUnitaire * input.quantite;

      const [commande] = await db
        .insert(commandesGaz)
        .values({
          clientId: ctx.user.id,
          marqueGazId: input.marqueGazId,
          boutiqueId: input.boutiqueId,
          quantite: input.quantite,
          echangeBouteilleVide: input.echangeBouteilleVide,
          adresseLivraison: input.adresseLivraison,
          latitude: input.latitude,
          longitude: input.longitude,
          prixTotal: prixTotal.toString(),
          notes: input.notes,
          statut: "en_attente",
        })
        .returning();

      return commande;
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
      })
      .from(commandesGaz)
      .innerJoin(boutiquesGaz, eq(commandesGaz.boutiqueId, boutiquesGaz.id))
      .where(eq(commandesGaz.statut, "confirmee"));

    return rows
      .filter((r) => zones.includes(r.boutiqueCommune ?? "") || zones.includes(r.boutiqueVille))
      .map((r) => ({
        ...r.commande,
        boutiqueNom: r.boutiqueNom,
        boutiqueVille: r.boutiqueVille,
        boutiqueCommune: r.boutiqueCommune,
        boutiqueAdresse: r.boutiqueAdresse,
      }));
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

      const [commande] = await db
        .update(commandesGaz)
        .set({
          statut: "en_livraison",
          livreurId: profilLivreur.id,
        })
        .where(and(eq(commandesGaz.id, input.commandeId), eq(commandesGaz.statut, "confirmee")))
        .returning();

      if (!commande) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "Cette livraison a déjà été prise par un autre livreur",
        });
      }

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
        .set({ statut: "livree", livreeAt: new Date() })
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
});
