import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { and, eq, sql } from "drizzle-orm";
import { router, protectedProcedure, requireRole } from "../trpc.js";
import { db, schema } from "../db/index.js";

const { demandesRamassage, ramasseurs, notifications } = schema;

export const ramassageRouter = router({
  // Le client crée une demande de ramassage
  creerDemande: protectedProcedure
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
      })
    )
    .mutation(async ({ ctx, input }) => {
      const [demande] = await db
        .insert(demandesRamassage)
        .values({
          clientId: ctx.user.id,
          adresse: input.adresse,
          latitude: input.latitude,
          longitude: input.longitude,
          ville: input.ville,
          commune: input.commune,
          typeDechet: input.typeDechet,
          quantiteEstimee: input.quantiteEstimee,
          prixPropose: input.prixPropose?.toString(),
          statut: "en_attente",
        })
        .returning();

      // TODO: notifier par push/SMS tous les ramasseurs validés couvrant cette commune/ville
      return demande;
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
        .set({ statut: "terminee", terminatedAt: new Date() })
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
});
