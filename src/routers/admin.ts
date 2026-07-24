import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { eq, desc, count, and } from "drizzle-orm";
import { router, requireRole } from "../trpc.js";
import { db, schema } from "../db/index.js";

const {
  commandesGaz,
  demandesRamassage,
  boutiquesGaz,
  ramasseurs,
  utilisateurs,
  statutCommandeGazEnum,
} = schema;

const adminProcedure = requireRole("admin");

export const adminRouter = router({
  // Vue d'ensemble pour la page d'accueil du dashboard
  stats: adminProcedure.query(async () => {
    const [commandesEnAttente] = await db
      .select({ n: count() })
      .from(commandesGaz)
      .where(eq(commandesGaz.statut, "en_attente"));
    const [commandesConfirmees] = await db
      .select({ n: count() })
      .from(commandesGaz)
      .where(eq(commandesGaz.statut, "confirmee"));
    const [commandesLivrees] = await db
      .select({ n: count() })
      .from(commandesGaz)
      .where(eq(commandesGaz.statut, "livree"));
    const [demandesEnAttente] = await db
      .select({ n: count() })
      .from(demandesRamassage)
      .where(eq(demandesRamassage.statut, "en_attente"));
    const [demandesEnCours] = await db
      .select({ n: count() })
      .from(demandesRamassage)
      .where(eq(demandesRamassage.statut, "en_cours"));
    const [boutiquesEnAttente] = await db
      .select({ n: count() })
      .from(boutiquesGaz)
      .where(eq(boutiquesGaz.statutValidation, "en_attente"));
    const [ramasseursEnAttente] = await db
      .select({ n: count() })
      .from(ramasseurs)
      .where(eq(ramasseurs.statutValidation, "en_attente"));

    return {
      commandesGaz: {
        enAttente: commandesEnAttente.n,
        confirmees: commandesConfirmees.n,
        livrees: commandesLivrees.n,
      },
      ramassage: {
        enAttente: demandesEnAttente.n,
        enCours: demandesEnCours.n,
      },
      validationsEnAttente: {
        boutiques: boutiquesEnAttente.n,
        ramasseurs: ramasseursEnAttente.n,
      },
    };
  }),

  // ---- Commandes gaz ----
  listCommandesGaz: adminProcedure
    .input(
      z.object({
        statut: z.enum(statutCommandeGazEnum.enumValues).optional(),
      })
    )
    .query(async ({ input }) => {
      const rows = await db
        .select({
          commande: commandesGaz,
          clientNom: utilisateurs.nom,
          clientTelephone: utilisateurs.telephone,
        })
        .from(commandesGaz)
        .innerJoin(utilisateurs, eq(commandesGaz.clientId, utilisateurs.id))
        .where(input.statut ? eq(commandesGaz.statut, input.statut) : undefined)
        .orderBy(desc(commandesGaz.createdAt));

      return rows.map((r) => ({ ...r.commande, clientNom: r.clientNom, clientTelephone: r.clientTelephone }));
    }),

  // ---- Demandes de ramassage ----
  listDemandesRamassage: adminProcedure
    .input(
      z.object({
        statut: z
          .enum(["en_attente", "validee", "en_cours", "terminee", "annulee"])
          .optional(),
      })
    )
    .query(async ({ input }) => {
      const rows = await db
        .select({
          demande: demandesRamassage,
          clientNom: utilisateurs.nom,
          clientTelephone: utilisateurs.telephone,
        })
        .from(demandesRamassage)
        .innerJoin(utilisateurs, eq(demandesRamassage.clientId, utilisateurs.id))
        .where(input.statut ? eq(demandesRamassage.statut, input.statut) : undefined)
        .orderBy(desc(demandesRamassage.createdAt));

      return rows.map((r) => ({ ...r.demande, clientNom: r.clientNom, clientTelephone: r.clientTelephone }));
    }),

  // ---- Boutiques ----
  listBoutiques: adminProcedure.query(async () => {
    return db.select().from(boutiquesGaz).orderBy(desc(boutiquesGaz.createdAt));
  }),

  validerBoutique: adminProcedure
    .input(z.object({ boutiqueId: z.string().uuid(), approuver: z.boolean() }))
    .mutation(async ({ input }) => {
      const [boutique] = await db
        .update(boutiquesGaz)
        .set({ statutValidation: input.approuver ? "valide" : "rejete" })
        .where(eq(boutiquesGaz.id, input.boutiqueId))
        .returning();

      if (!boutique) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Boutique introuvable" });
      }
      return boutique;
    }),

  // ---- Ramasseurs ----
  listRamasseurs: adminProcedure.query(async () => {
    const rows = await db
      .select({
        ramasseur: ramasseurs,
        nom: utilisateurs.nom,
        telephone: utilisateurs.telephone,
      })
      .from(ramasseurs)
      .innerJoin(utilisateurs, eq(ramasseurs.utilisateurId, utilisateurs.id))
      .orderBy(desc(ramasseurs.createdAt));

    return rows.map((r) => ({ ...r.ramasseur, nom: r.nom, telephone: r.telephone }));
  }),

  validerRamasseur: adminProcedure
    .input(z.object({ ramasseurId: z.string().uuid(), approuver: z.boolean() }))
    .mutation(async ({ input }) => {
      const [ramasseur] = await db
        .update(ramasseurs)
        .set({ statutValidation: input.approuver ? "valide" : "rejete" })
        .where(eq(ramasseurs.id, input.ramasseurId))
        .returning();

      if (!ramasseur) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Ramasseur introuvable" });
      }
      return ramasseur;
    }),
});
