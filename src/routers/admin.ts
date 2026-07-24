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
  livreurs,
  utilisateurs,
  marquesGaz,
  stockBoutique,
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
    const [livreursEnAttente] = await db
      .select({ n: count() })
      .from(livreurs)
      .where(eq(livreurs.statutValidation, "en_attente"));

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
        livreurs: livreursEnAttente.n,
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

  // Création directe d'un compte ramasseur par l'admin (auto-validé, pas de mobile requis)
  creerRamasseur: adminProcedure
    .input(
      z.object({
        nom: z.string().min(2),
        telephone: z.string().min(8),
        motDePasse: z.string().min(6),
        ville: z.string().min(2),
        type: z.enum(["particulier", "societe"]),
        nomSociete: z.string().optional(),
        zonesCouvertes: z.array(z.string()).min(1),
        vehicule: z.string().optional(),
      })
    )
    .mutation(async ({ input }) => {
      const bcrypt = (await import("bcryptjs")).default;

      const existant = await db
        .select()
        .from(utilisateurs)
        .where(eq(utilisateurs.telephone, input.telephone));

      if (existant.length > 0) {
        throw new TRPCError({ code: "CONFLICT", message: "Ce numéro est déjà utilisé" });
      }

      const motDePasseHash = await bcrypt.hash(input.motDePasse, 10);

      const [user] = await db
        .insert(utilisateurs)
        .values({
          nom: input.nom,
          telephone: input.telephone,
          motDePasseHash,
          ville: input.ville,
          role: "ramasseur",
        })
        .returning();

      const [ramasseur] = await db
        .insert(ramasseurs)
        .values({
          utilisateurId: user.id,
          type: input.type,
          nomSociete: input.nomSociete,
          zonesCouvertes: input.zonesCouvertes,
          vehicule: input.vehicule,
          statutValidation: "valide", // créé par l'admin : validé d'office
        })
        .returning();

      return { utilisateur: user, ramasseur };
    }),

  // ---- Livreurs de gaz ----
  listLivreurs: adminProcedure.query(async () => {
    const rows = await db
      .select({
        livreur: livreurs,
        nom: utilisateurs.nom,
        telephone: utilisateurs.telephone,
      })
      .from(livreurs)
      .innerJoin(utilisateurs, eq(livreurs.utilisateurId, utilisateurs.id))
      .orderBy(desc(livreurs.createdAt));

    return rows.map((r) => ({ ...r.livreur, nom: r.nom, telephone: r.telephone }));
  }),

  validerLivreur: adminProcedure
    .input(z.object({ livreurId: z.string().uuid(), approuver: z.boolean() }))
    .mutation(async ({ input }) => {
      const [livreur] = await db
        .update(livreurs)
        .set({ statutValidation: input.approuver ? "valide" : "rejete" })
        .where(eq(livreurs.id, input.livreurId))
        .returning();

      if (!livreur) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Livreur introuvable" });
      }
      return livreur;
    }),

  // Création directe d'un compte livreur par l'admin (auto-validé, pas de mobile requis)
  creerLivreur: adminProcedure
    .input(
      z.object({
        nom: z.string().min(2),
        telephone: z.string().min(8),
        motDePasse: z.string().min(6),
        ville: z.string().min(2),
        vehicule: z.string().optional(),
        zonesCouvertes: z.array(z.string()).min(1),
      })
    )
    .mutation(async ({ input }) => {
      const bcrypt = (await import("bcryptjs")).default;

      const existant = await db
        .select()
        .from(utilisateurs)
        .where(eq(utilisateurs.telephone, input.telephone));

      if (existant.length > 0) {
        throw new TRPCError({ code: "CONFLICT", message: "Ce numéro est déjà utilisé" });
      }

      const motDePasseHash = await bcrypt.hash(input.motDePasse, 10);

      const [user] = await db
        .insert(utilisateurs)
        .values({
          nom: input.nom,
          telephone: input.telephone,
          motDePasseHash,
          ville: input.ville,
          role: "livreur",
        })
        .returning();

      const [livreur] = await db
        .insert(livreurs)
        .values({
          utilisateurId: user.id,
          vehicule: input.vehicule,
          zonesCouvertes: input.zonesCouvertes,
          statutValidation: "valide", // créé par l'admin : validé d'office
        })
        .returning();

      return { utilisateur: user, livreur };
    }),

  // ---- Marques de gaz (référentiel) ----
  listMarquesGaz: adminProcedure.query(async () => {
    return db.select().from(marquesGaz);
  }),

  creerMarqueGaz: adminProcedure
    .input(
      z.object({
        nom: z.string().min(2),
        taille: z.string().min(1),
        prixRecharge: z.number().positive(),
        prixConsigne: z.number().nonnegative().optional(),
      })
    )
    .mutation(async ({ input }) => {
      const [marque] = await db
        .insert(marquesGaz)
        .values({
          nom: input.nom,
          taille: input.taille,
          prixRecharge: input.prixRecharge.toString(),
          prixConsigne: input.prixConsigne?.toString(),
        })
        .returning();
      return marque;
    }),

  // ---- Création d'un compte boutique (par l'admin, auto-validé) ----
  creerBoutique: adminProcedure
    .input(
      z.object({
        nom: z.string().min(2),
        telephone: z.string().min(8),
        motDePasse: z.string().min(6),
        nomBoutique: z.string().min(2),
        ville: z.string().min(2),
        commune: z.string().optional(),
        adresse: z.string().optional(),
        latitude: z.number().optional(),
        longitude: z.number().optional(),
      })
    )
    .mutation(async ({ input }) => {
      const bcrypt = (await import("bcryptjs")).default;

      const existant = await db
        .select()
        .from(utilisateurs)
        .where(eq(utilisateurs.telephone, input.telephone));

      if (existant.length > 0) {
        throw new TRPCError({ code: "CONFLICT", message: "Ce numéro est déjà utilisé" });
      }

      const motDePasseHash = await bcrypt.hash(input.motDePasse, 10);

      const [user] = await db
        .insert(utilisateurs)
        .values({
          nom: input.nom,
          telephone: input.telephone,
          motDePasseHash,
          ville: input.ville,
          commune: input.commune,
          role: "boutique",
        })
        .returning();

      const [boutique] = await db
        .insert(boutiquesGaz)
        .values({
          utilisateurId: user.id,
          nomBoutique: input.nomBoutique,
          ville: input.ville,
          commune: input.commune,
          adresse: input.adresse,
          latitude: input.latitude,
          longitude: input.longitude,
          statutValidation: "valide", // créée par l'admin : validée d'office
        })
        .returning();

      return { utilisateur: user, boutique };
    }),

  // ---- Gestion du stock d'une boutique ----
  majStock: adminProcedure
    .input(
      z.object({
        boutiqueId: z.string().uuid(),
        marqueGazId: z.string().uuid(),
        quantiteDisponible: z.number().int().nonnegative(),
      })
    )
    .mutation(async ({ input }) => {
      const [existant] = await db
        .select()
        .from(stockBoutique)
        .where(
          and(
            eq(stockBoutique.boutiqueId, input.boutiqueId),
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
          boutiqueId: input.boutiqueId,
          marqueGazId: input.marqueGazId,
          quantiteDisponible: input.quantiteDisponible,
        })
        .returning();
      return créé;
    }),
});
