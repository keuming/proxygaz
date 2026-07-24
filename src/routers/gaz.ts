import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { and, eq, gt, sql } from "drizzle-orm";
import { router, protectedProcedure, requireRole } from "../trpc.js";
import { db, schema } from "../db/index.js";

const { commandesGaz, marquesGaz, boutiquesGaz, stockBoutique, livreurs, notifications } = schema;

export const gazRouter = router({
  // Liste des marques/tailles disponibles (catalogue public)
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

  mesCommandes: protectedProcedure.query(async ({ ctx }) => {
    return db
      .select()
      .from(commandesGaz)
      .where(eq(commandesGaz.clientId, ctx.user.id));
  }),

  // ---- Espace boutique (self-service) ----

  commandesBoutique: requireRole("boutique").query(async ({ ctx }) => {
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
      .where(eq(commandesGaz.boutiqueId, boutique.id));

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
    .input(z.object({ marqueGazId: z.string().uuid(), quantiteDisponible: z.number().int().nonnegative() }))
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
        const [maj] = await db
          .update(stockBoutique)
          .set({ quantiteDisponible: input.quantiteDisponible, updatedAt: new Date() })
          .where(eq(stockBoutique.id, existant.id))
          .returning();
        return maj;
      }

      const [créé] = await db
        .insert(stockBoutique)
        .values({
          boutiqueId: boutique.id,
          marqueGazId: input.marqueGazId,
          quantiteDisponible: input.quantiteDisponible,
        })
        .returning();
      return créé;
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
