import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { router, protectedProcedure } from "../trpc.js";
import { db, schema } from "../db/index.js";
import { initierPaiement, verifierStatutPaiement } from "../services/hub2.js";

const { paiements, commandesGaz, demandesRamassage, utilisateurs } = schema;

export const paiementsRouter = router({
  // Initie un paiement Mobile Money pour une commande gaz ou une demande de ramassage
  initierPaiementMobileMoney: protectedProcedure
    .input(
      z.object({
        typeService: z.enum(["gaz", "ramassage"]),
        commandeGazId: z.string().uuid().optional(),
        demandeRamassageId: z.string().uuid().optional(),
        operateur: z.enum(["orange_money", "mtn_momo", "wave", "moov_money"]),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const [utilisateur] = await db
        .select()
        .from(utilisateurs)
        .where(eq(utilisateurs.id, ctx.user.id));

      let montant: number;

      if (input.typeService === "gaz") {
        if (!input.commandeGazId) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "commandeGazId requis" });
        }
        const [commande] = await db
          .select()
          .from(commandesGaz)
          .where(eq(commandesGaz.id, input.commandeGazId));
        if (!commande) throw new TRPCError({ code: "NOT_FOUND", message: "Commande introuvable" });
        montant = parseFloat(commande.prixTotal);
      } else {
        if (!input.demandeRamassageId) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "demandeRamassageId requis" });
        }
        const [demande] = await db
          .select()
          .from(demandesRamassage)
          .where(eq(demandesRamassage.id, input.demandeRamassageId));
        if (!demande || !demande.prixPropose) {
          throw new TRPCError({ code: "NOT_FOUND", message: "Demande introuvable ou sans prix" });
        }
        montant = parseFloat(demande.prixPropose);
      }

      const [paiement] = await db
        .insert(paiements)
        .values({
          utilisateurId: ctx.user.id,
          typeService: input.typeService,
          commandeGazId: input.commandeGazId,
          demandeRamassageId: input.demandeRamassageId,
          montant: montant.toString(),
          modePaiement: "mobile_money",
          operateur: input.operateur,
          statut: "en_attente",
        })
        .returning();

      try {
        const reponseHub2 = await initierPaiement({
          montant,
          telephone: utilisateur.telephone,
          operateur: input.operateur,
          reference: paiement.id,
          description: `ProxiGaz - ${input.typeService}`,
        });

        await db
          .update(paiements)
          .set({
            hub2TransactionId: reponseHub2.transaction_id,
            rawResponse: reponseHub2,
            updatedAt: new Date(),
          })
          .where(eq(paiements.id, paiement.id));

        return { paiementId: paiement.id, ...reponseHub2 };
      } catch (err) {
        await db
          .update(paiements)
          .set({ statut: "echoue", updatedAt: new Date() })
          .where(eq(paiements.id, paiement.id));
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Échec de l'initiation du paiement Mobile Money",
        });
      }
    }),

  // Vérifie le statut d'un paiement (polling côté mobile en attendant le webhook)
  statutPaiement: protectedProcedure
    .input(z.object({ paiementId: z.string().uuid() }))
    .query(async ({ input }) => {
      const [paiement] = await db
        .select()
        .from(paiements)
        .where(eq(paiements.id, input.paiementId));

      if (!paiement) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Paiement introuvable" });
      }

      if (paiement.statut === "en_attente" && paiement.hub2TransactionId) {
        const statutHub2 = await verifierStatutPaiement(paiement.hub2TransactionId);
        if (statutHub2.status === "SUCCESS") {
          await db
            .update(paiements)
            .set({ statut: "reussi", updatedAt: new Date() })
            .where(eq(paiements.id, paiement.id));
          return { ...paiement, statut: "reussi" };
        } else if (statutHub2.status === "FAILED") {
          await db
            .update(paiements)
            .set({ statut: "echoue", updatedAt: new Date() })
            .where(eq(paiements.id, paiement.id));
          return { ...paiement, statut: "echoue" };
        }
      }

      return paiement;
    }),
});
