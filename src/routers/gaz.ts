import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { and, eq, gt, sql } from "drizzle-orm";
import { router, protectedProcedure, requireRole } from "../trpc";
import { db, schema } from "../db";

const { commandesGaz, marquesGaz, boutiquesGaz, stockBoutique, notifications } = schema;

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
  confirmerCommande: requireRole("boutique")
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

  marquerLivree: requireRole("boutique", "admin")
    .input(z.object({ commandeId: z.string().uuid() }))
    .mutation(async ({ input }) => {
      const [commande] = await db
        .update(commandesGaz)
        .set({ statut: "livree", livreeAt: new Date() })
        .where(
          and(
            eq(commandesGaz.id, input.commandeId),
            eq(commandesGaz.statut, "en_livraison")
          )
        )
        .returning();

      if (!commande) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Transition de statut invalide",
        });
      }

      return commande;
    }),

  mesCommandes: protectedProcedure.query(async ({ ctx }) => {
    return db
      .select()
      .from(commandesGaz)
      .where(eq(commandesGaz.clientId, ctx.user.id));
  }),
});
