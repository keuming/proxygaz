import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { eq, desc, count, and, or, sql, like, ilike, inArray } from "drizzle-orm";
import { router, requireRole } from "../trpc.js";
import { db, schema } from "../db/index.js";

const {
  commandesGaz,
  demandesRamassage,
  boutiquesGaz,
  ramasseurs,
  livreurs,
  societesLivraison,
  utilisateurs,
  marquesGaz,
  stockBoutique,
  demandesCredit,
  mouvementsCredit,
  fournisseurs,
  approvisionnements,
  mouvementsStock,
  notifications,
  paiements,
  statutCommandeGazEnum,
} = schema;

const adminProcedure = requireRole("admin");
const CREDITS_BIENVENUE = 5; // offerts à la création d'un compte livreur/ramasseur

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
    const rows = await db
      .select({
        boutique: boutiquesGaz,
        gerantNom: utilisateurs.nom,
        gerantTelephone: utilisateurs.telephone,
        nomSociete: societesLivraison.nomSociete,
      })
      .from(boutiquesGaz)
      .innerJoin(utilisateurs, eq(boutiquesGaz.utilisateurId, utilisateurs.id))
      .leftJoin(societesLivraison, eq(boutiquesGaz.societeLivraisonId, societesLivraison.id))
      .orderBy(desc(boutiquesGaz.createdAt));

    return rows.map((r) => ({
      ...r.boutique,
      gerantNom: r.gerantNom,
      gerantTelephone: r.gerantTelephone,
      nomSociete: r.nomSociete,
    }));
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
        codePin: z.string().regex(/^\d{4}$/, "Le code PIN doit comporter exactement 4 chiffres"),
        pays: z.string().min(2).default("Côte d'Ivoire"),
        ville: z.string().min(2),
        commune: z.string().optional(),
        quartier: z.string().optional(),
        latitude: z.number().optional(),
        longitude: z.number().optional(),
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

      const motDePasseHash = await bcrypt.hash(input.codePin, 10);

      const [user] = await db
        .insert(utilisateurs)
        .values({
          nom: input.nom,
          telephone: input.telephone,
          motDePasseHash,
          ville: input.ville,
          commune: input.commune,
          latitude: input.latitude,
          longitude: input.longitude,
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
          pays: input.pays,
          ville: input.ville,
          commune: input.commune,
          quartier: input.quartier,
          latitude: input.latitude,
          longitude: input.longitude,
          statutValidation: "valide", // créé par l'admin : validé d'office
          credits: CREDITS_BIENVENUE,
        })
        .returning();

      await db.insert(mouvementsCredit).values({
        ramasseurId: ramasseur.id,
        typeMouvement: "ajustement",
        quantite: CREDITS_BIENVENUE,
        soldeApres: CREDITS_BIENVENUE,
        notes: "Crédits de bienvenue offerts à la création du compte",
      });

      return { utilisateur: user, ramasseur };
    }),

  // ---- Livreurs de gaz ----
  listLivreurs: adminProcedure.query(async () => {
    const rows = await db
      .select({
        livreur: livreurs,
        nom: utilisateurs.nom,
        telephone: utilisateurs.telephone,
        nomSociete: societesLivraison.nomSociete,
      })
      .from(livreurs)
      .innerJoin(utilisateurs, eq(livreurs.utilisateurId, utilisateurs.id))
      .leftJoin(societesLivraison, eq(livreurs.societeLivraisonId, societesLivraison.id))
      .orderBy(desc(livreurs.createdAt));

    return rows.map((r) => ({
      ...r.livreur,
      nom: r.nom,
      telephone: r.telephone,
      nomSociete: r.nomSociete,
    }));
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

  // Update : modification des informations d'un livreur existant
  modifierLivreur: adminProcedure
    .input(
      z.object({
        livreurId: z.string().uuid(),
        vehicule: z.string().optional(),
        zonesCouvertes: z.array(z.string()).optional(),
        pays: z.string().min(2).optional(),
        ville: z.string().min(2).optional(),
        commune: z.string().optional(),
        quartier: z.string().optional(),
        latitude: z.number().optional(),
        longitude: z.number().optional(),
      })
    )
    .mutation(async ({ input }) => {
      const { livreurId, ...champs } = input;

      const [livreur] = await db
        .update(livreurs)
        .set(champs)
        .where(eq(livreurs.id, livreurId))
        .returning();

      if (!livreur) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Livreur introuvable" });
      }
      return livreur;
    }),

  // Delete : désactivation (même logique que boutiques/ramasseurs — jamais de suppression
  // définitive, l'historique des livraisons et des crédits doit rester intact).
  changerStatutLivreur: adminProcedure
    .input(
      z.object({
        livreurId: z.string().uuid(),
        statut: z.enum(["en_attente", "valide", "rejete", "suspendu"]),
      })
    )
    .mutation(async ({ input }) => {
      const [livreur] = await db
        .update(livreurs)
        .set({ statutValidation: input.statut })
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
        codePin: z.string().regex(/^\d{4}$/, "Le code PIN doit comporter exactement 4 chiffres"),
        pays: z.string().min(2).default("Côte d'Ivoire"),
        ville: z.string().min(2),
        commune: z.string().optional(),
        quartier: z.string().optional(),
        latitude: z.number().optional(),
        longitude: z.number().optional(),
        vehicule: z.string().optional(),
        zonesCouvertes: z.array(z.string()).min(1),
        societeLivraisonId: z.string().uuid().optional(),
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

      const motDePasseHash = await bcrypt.hash(input.codePin, 10);

      const [user] = await db
        .insert(utilisateurs)
        .values({
          nom: input.nom,
          telephone: input.telephone,
          motDePasseHash,
          ville: input.ville,
          commune: input.commune,
          latitude: input.latitude,
          longitude: input.longitude,
          role: "livreur",
        })
        .returning();

      const rattacheASociete = !!input.societeLivraisonId;

      const [livreur] = await db
        .insert(livreurs)
        .values({
          utilisateurId: user.id,
          societeLivraisonId: input.societeLivraisonId,
          vehicule: input.vehicule,
          zonesCouvertes: input.zonesCouvertes,
          pays: input.pays,
          ville: input.ville,
          commune: input.commune,
          quartier: input.quartier,
          latitude: input.latitude,
          longitude: input.longitude,
          statutValidation: "valide", // créé par l'admin : validé d'office
          // Si rattaché à une société, ce livreur puise dans son pot commun — pas de crédits
          // individuels dans ce cas.
          credits: rattacheASociete ? 0 : CREDITS_BIENVENUE,
        })
        .returning();

      if (!rattacheASociete) {
        await db.insert(mouvementsCredit).values({
          livreurId: livreur.id,
          typeMouvement: "ajustement",
          quantite: CREDITS_BIENVENUE,
          soldeApres: CREDITS_BIENVENUE,
          notes: "Crédits de bienvenue offerts à la création du compte",
        });
      }

      return { utilisateur: user, livreur };
    }),

  // ============================================================
  // SOCIÉTÉS DE LIVRAISON
  // ============================================================

  listSocietesLivraison: adminProcedure.query(async () => {
    const rows = await db
      .select({
        societe: societesLivraison,
        nom: utilisateurs.nom,
        telephone: utilisateurs.telephone,
      })
      .from(societesLivraison)
      .innerJoin(utilisateurs, eq(societesLivraison.utilisateurId, utilisateurs.id))
      .orderBy(desc(societesLivraison.createdAt));

    // Nombre de livreurs et de boutiques rattachés à chaque société, pour affichage dans la liste admin
    const compteursLivreurs = await db
      .select({ societeLivraisonId: livreurs.societeLivraisonId, n: sql<number>`count(*)::int` })
      .from(livreurs)
      .where(sql`${livreurs.societeLivraisonId} IS NOT NULL`)
      .groupBy(livreurs.societeLivraisonId);
    const compteurParSociete = new Map(compteursLivreurs.map((c) => [c.societeLivraisonId, c.n]));

    const compteursBoutiques = await db
      .select({ societeLivraisonId: boutiquesGaz.societeLivraisonId, n: sql<number>`count(*)::int` })
      .from(boutiquesGaz)
      .where(sql`${boutiquesGaz.societeLivraisonId} IS NOT NULL`)
      .groupBy(boutiquesGaz.societeLivraisonId);
    const compteurBoutiquesParSociete = new Map(compteursBoutiques.map((c) => [c.societeLivraisonId, c.n]));

    return rows.map((r) => ({
      ...r.societe,
      gerantNom: r.nom,
      gerantTelephone: r.telephone,
      nombreLivreurs: compteurParSociete.get(r.societe.id) ?? 0,
      nombreBoutiques: compteurBoutiquesParSociete.get(r.societe.id) ?? 0,
    }));
  }),

  changerStatutSocieteLivraison: adminProcedure
    .input(
      z.object({
        societeId: z.string().uuid(),
        statut: z.enum(["en_attente", "valide", "rejete", "suspendu"]),
      })
    )
    .mutation(async ({ input }) => {
      const [societe] = await db
        .update(societesLivraison)
        .set({ statutValidation: input.statut })
        .where(eq(societesLivraison.id, input.societeId))
        .returning();

      if (!societe) throw new TRPCError({ code: "NOT_FOUND", message: "Société introuvable" });
      return societe;
    }),

  modifierSocieteLivraison: adminProcedure
    .input(
      z.object({
        societeId: z.string().uuid(),
        nomSociete: z.string().min(2).optional(),
        pays: z.string().min(2).optional(),
        ville: z.string().min(2).optional(),
        commune: z.string().optional(),
        quartier: z.string().optional(),
        latitude: z.number().optional(),
        longitude: z.number().optional(),
      })
    )
    .mutation(async ({ input }) => {
      const { societeId, ...champs } = input;

      const [societe] = await db
        .update(societesLivraison)
        .set(champs)
        .where(eq(societesLivraison.id, societeId))
        .returning();

      if (!societe) throw new TRPCError({ code: "NOT_FOUND", message: "Société introuvable" });
      return societe;
    }),

  // Création directe d'un compte société de livraison par l'admin (auto-validée)
  creerSocieteLivraison: adminProcedure
    .input(
      z.object({
        nom: z.string().min(2),
        telephone: z.string().min(8),
        codePin: z.string().regex(/^\d{4}$/, "Le code PIN doit comporter exactement 4 chiffres"),
        nomSociete: z.string().min(2),
        pays: z.string().min(2).default("Côte d'Ivoire"),
        ville: z.string().min(2),
        commune: z.string().optional(),
        quartier: z.string().optional(),
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

      const motDePasseHash = await bcrypt.hash(input.codePin, 10);

      const [user] = await db
        .insert(utilisateurs)
        .values({
          nom: input.nom,
          telephone: input.telephone,
          motDePasseHash,
          ville: input.ville,
          commune: input.commune,
          latitude: input.latitude,
          longitude: input.longitude,
          role: "societe_livraison",
        })
        .returning();

      const [societe] = await db
        .insert(societesLivraison)
        .values({
          utilisateurId: user.id,
          nomSociete: input.nomSociete,
          pays: input.pays,
          ville: input.ville,
          commune: input.commune,
          quartier: input.quartier,
          latitude: input.latitude,
          longitude: input.longitude,
          statutValidation: "valide", // créée par l'admin : validée d'office
          credits: CREDITS_BIENVENUE,
        })
        .returning();

      await db.insert(mouvementsCredit).values({
        societeLivraisonId: societe.id,
        typeMouvement: "ajustement",
        quantite: CREDITS_BIENVENUE,
        soldeApres: CREDITS_BIENVENUE,
        notes: "Crédits de bienvenue offerts à la création du compte",
      });

      return { utilisateur: user, societe };
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

  // Modification du référentiel (nom, taille, prix homologué, activation/désactivation).
  // C'est le seul endroit où le prix homologué peut changer — les boutiques n'y ont jamais
  // accès, elles ne gèrent que leur quantité en stock (voir majMonStock / approvisionnements).
  modifierMarqueGaz: adminProcedure
    .input(
      z.object({
        marqueId: z.string().uuid(),
        nom: z.string().min(2).optional(),
        taille: z.string().min(1).optional(),
        prixRecharge: z.number().positive().optional(),
        prixConsigne: z.number().nonnegative().optional(),
        actif: z.boolean().optional(),
      })
    )
    .mutation(async ({ input }) => {
      const { marqueId, prixRecharge, prixConsigne, ...reste } = input;

      const [marque] = await db
        .update(marquesGaz)
        .set({
          ...reste,
          ...(prixRecharge !== undefined ? { prixRecharge: prixRecharge.toString() } : {}),
          ...(prixConsigne !== undefined ? { prixConsigne: prixConsigne.toString() } : {}),
        })
        .where(eq(marquesGaz.id, marqueId))
        .returning();

      if (!marque) throw new TRPCError({ code: "NOT_FOUND", message: "Marque introuvable" });
      return marque;
    }),

  // ---- Création d'un compte boutique (par l'admin, auto-validé) ----
  creerBoutique: adminProcedure
    .input(
      z.object({
        nom: z.string().min(2),
        telephone: z.string().min(8),
        codePin: z.string().regex(/^\d{4}$/, "Le code PIN doit comporter exactement 4 chiffres"),
        nomBoutique: z.string().min(2),
        pays: z.string().min(2).default("Côte d'Ivoire"),
        ville: z.string().min(2),
        commune: z.string().optional(),
        quartier: z.string().optional(),
        adresse: z.string().optional(),
        latitude: z.number().optional(),
        longitude: z.number().optional(),
        societeLivraisonId: z.string().uuid().optional(),
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

      const motDePasseHash = await bcrypt.hash(input.codePin, 10);

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
          societeLivraisonId: input.societeLivraisonId,
          nomBoutique: input.nomBoutique,
          pays: input.pays,
          ville: input.ville,
          commune: input.commune,
          quartier: input.quartier,
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

  // ============================================================
  // BACKOFFICE SUPPORT / APRÈS-VENTE
  // ============================================================

  // Vue globale de tous les encaissements (gaz + ramassage), toutes boutiques et
  // ramasseurs confondus — indispensable pour la comptabilité et le support client,
  // qui n'ont pas à se connecter sur chaque compte individuel pour vérifier un paiement.
  encaissementsGlobal: adminProcedure
    .input(z.object({ depuis: z.string().datetime().optional() }).optional())
    .query(async ({ input }) => {
      const conditionsGaz = [eq(commandesGaz.encaisse, true)];
      if (input?.depuis) {
        conditionsGaz.push(sql`${commandesGaz.encaisseAt} >= ${input.depuis}::timestamp`);
      }

      const clientUtilisateurs = schema.utilisateurs;

      const lignesGaz = await db
        .select({
          commande: commandesGaz,
          clientNom: clientUtilisateurs.nom,
          clientTelephone: clientUtilisateurs.telephone,
          boutiqueNom: boutiquesGaz.nomBoutique,
        })
        .from(commandesGaz)
        .innerJoin(clientUtilisateurs, eq(commandesGaz.clientId, clientUtilisateurs.id))
        .leftJoin(boutiquesGaz, eq(commandesGaz.boutiqueId, boutiquesGaz.id))
        .where(and(...conditionsGaz))
        .orderBy(desc(commandesGaz.encaisseAt));

      const conditionsRamassage = [eq(demandesRamassage.encaisse, true)];
      if (input?.depuis) {
        conditionsRamassage.push(sql`${demandesRamassage.encaisseAt} >= ${input.depuis}::timestamp`);
      }

      const lignesRamassage = await db
        .select({
          demande: demandesRamassage,
          clientNom: clientUtilisateurs.nom,
          clientTelephone: clientUtilisateurs.telephone,
          ramasseurNomSociete: ramasseurs.nomSociete,
        })
        .from(demandesRamassage)
        .innerJoin(clientUtilisateurs, eq(demandesRamassage.clientId, clientUtilisateurs.id))
        .leftJoin(ramasseurs, eq(demandesRamassage.ramasseurId, ramasseurs.id))
        .where(and(...conditionsRamassage));

      const transactions = [
        ...lignesGaz.map((r) => ({
          id: r.commande.id,
          type: "gaz" as const,
          service: "Bouteille de gaz",
          clientNom: r.clientNom,
          clientTelephone: r.clientTelephone,
          partenaireNom: r.boutiqueNom ?? "—",
          montant: Number(r.commande.prixTotal),
          modePaiement: r.commande.modePaiement,
          encaisseAt: r.commande.encaisseAt,
        })),
        ...lignesRamassage.map((r) => ({
          id: r.demande.id,
          type: "ramassage" as const,
          service: "Ramassage",
          clientNom: r.clientNom,
          clientTelephone: r.clientTelephone,
          partenaireNom: r.ramasseurNomSociete ?? "—",
          montant: Number(r.demande.prixPropose ?? 0),
          modePaiement: r.demande.modePaiement,
          encaisseAt: r.demande.encaisseAt,
        })),
      ].sort((a, b) => {
        const dateA = a.encaisseAt ? new Date(a.encaisseAt).getTime() : 0;
        const dateB = b.encaisseAt ? new Date(b.encaisseAt).getTime() : 0;
        return dateB - dateA;
      });

      const totalEspeces = transactions
        .filter((t) => t.modePaiement === "especes_livraison")
        .reduce((s, t) => s + t.montant, 0);
      const totalMobilePay = transactions
        .filter((t) => t.modePaiement === "mobile_money")
        .reduce((s, t) => s + t.montant, 0);

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

  // Recherche par numéro de téléphone (client, boutique, livreur ou ramasseur) — retourne
  // l'historique complet pour permettre au support de traiter un litige en un seul écran :
  // qui a commandé quoi, avec qui, comment ça a été payé, et à quelle étape ça en est.
  rechercheParTelephone: adminProcedure
    .input(z.object({ telephone: z.string().min(3) }))
    .query(async ({ input }) => {
      const motif = `%${input.telephone}%`;

      const utilisateursTrouves = await db
        .select()
        .from(utilisateurs)
        .where(like(utilisateurs.telephone, motif));

      if (utilisateursTrouves.length === 0) {
        return { utilisateurs: [], commandesGaz: [], demandesRamassage: [] };
      }

      const ids = utilisateursTrouves.map((u) => u.id);

      // Commandes gaz où cet utilisateur est le client
      const commandesClient = await db
        .select({
          commande: commandesGaz,
          boutiqueNom: boutiquesGaz.nomBoutique,
          boutiqueTelephone: schema.utilisateurs.telephone,
        })
        .from(commandesGaz)
        .leftJoin(boutiquesGaz, eq(commandesGaz.boutiqueId, boutiquesGaz.id))
        .leftJoin(schema.utilisateurs, eq(boutiquesGaz.utilisateurId, schema.utilisateurs.id))
        .where(inArray(commandesGaz.clientId, ids))
        .orderBy(desc(commandesGaz.createdAt));

      // Demandes de ramassage où cet utilisateur est le client
      const demandesClient = await db
        .select({
          demande: demandesRamassage,
          ramasseurNomSociete: ramasseurs.nomSociete,
        })
        .from(demandesRamassage)
        .leftJoin(ramasseurs, eq(demandesRamassage.ramasseurId, ramasseurs.id))
        .where(inArray(demandesRamassage.clientId, ids))
        .orderBy(desc(demandesRamassage.createdAt));

      return {
        utilisateurs: utilisateursTrouves.map((u) => ({
          id: u.id,
          nom: u.nom,
          telephone: u.telephone,
          role: u.role,
          createdAt: u.createdAt,
        })),
        commandesGaz: commandesClient.map((r) => ({
          ...r.commande,
          boutiqueNom: r.boutiqueNom,
          boutiqueTelephone: r.boutiqueTelephone,
        })),
        demandesRamassage: demandesClient.map((r) => ({
          ...r.demande,
          ramasseurNomSociete: r.ramasseurNomSociete,
        })),
      };
    }),

  // ============================================================
  // SYSTÈME DE CRÉDIT — file de mise à disposition (validation des demandes d'achat)
  // ============================================================

  listDemandesCredit: adminProcedure
    .input(z.object({ statut: z.enum(["en_attente", "validee", "rejetee"]).optional() }).optional())
    .query(async ({ input }) => {
      const rows = await db
        .select({
          demande: demandesCredit,
          livreurNom: utilisateurs.nom,
          livreurTelephone: utilisateurs.telephone,
        })
        .from(demandesCredit)
        .leftJoin(livreurs, eq(demandesCredit.livreurId, livreurs.id))
        .leftJoin(utilisateurs, eq(livreurs.utilisateurId, utilisateurs.id))
        .where(input?.statut ? eq(demandesCredit.statut, input.statut) : undefined)
        .orderBy(desc(demandesCredit.createdAt));

      // Les demandes de ramasseurs n'ont pas de livreur associé (jointure ci-dessus renvoie null) ;
      // on complète séparément pour ceux-là.
      const rowsRamasseur = await db
        .select({
          demande: demandesCredit,
          ramasseurNom: utilisateurs.nom,
          ramasseurTelephone: utilisateurs.telephone,
          ramasseurNomSociete: ramasseurs.nomSociete,
        })
        .from(demandesCredit)
        .leftJoin(ramasseurs, eq(demandesCredit.ramasseurId, ramasseurs.id))
        .leftJoin(utilisateurs, eq(ramasseurs.utilisateurId, utilisateurs.id))
        .where(input?.statut ? eq(demandesCredit.statut, input.statut) : undefined)
        .orderBy(desc(demandesCredit.createdAt));

      const rowsSociete = await db
        .select({
          demande: demandesCredit,
          societeNom: societesLivraison.nomSociete,
          societeTelephone: utilisateurs.telephone,
        })
        .from(demandesCredit)
        .leftJoin(societesLivraison, eq(demandesCredit.societeLivraisonId, societesLivraison.id))
        .leftJoin(utilisateurs, eq(societesLivraison.utilisateurId, utilisateurs.id))
        .where(input?.statut ? eq(demandesCredit.statut, input.statut) : undefined)
        .orderBy(desc(demandesCredit.createdAt));

      const resultats = [
        ...rows
          .filter((r) => r.demande.livreurId !== null)
          .map((r) => ({
            ...r.demande,
            profil: "livreur" as const,
            nomDemandeur: r.livreurNom,
            telephoneDemandeur: r.livreurTelephone,
          })),
        ...rowsRamasseur
          .filter((r) => r.demande.ramasseurId !== null)
          .map((r) => ({
            ...r.demande,
            profil: "ramasseur" as const,
            nomDemandeur: r.ramasseurNomSociete ?? r.ramasseurNom,
            telephoneDemandeur: r.ramasseurTelephone,
          })),
        ...rowsSociete
          .filter((r) => r.demande.societeLivraisonId !== null)
          .map((r) => ({
            ...r.demande,
            profil: "societe_livraison" as const,
            nomDemandeur: r.societeNom,
            telephoneDemandeur: r.societeTelephone,
          })),
      ].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

      return resultats;
    }),

  // Mise à disposition effective : incrémente le solde du livreur/ramasseur et journalise.
  validerDemandeCredit: adminProcedure
    .input(z.object({ demandeId: z.string().uuid() }))
    .mutation(async ({ input }) => {
      const [demande] = await db
        .update(demandesCredit)
        .set({ statut: "validee", traiteeAt: new Date() })
        .where(and(eq(demandesCredit.id, input.demandeId), eq(demandesCredit.statut, "en_attente")))
        .returning();

      if (!demande) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Demande introuvable ou déjà traitée",
        });
      }

      if (demande.livreurId) {
        const [maj] = await db
          .update(livreurs)
          .set({ credits: sql`${livreurs.credits} + ${demande.quantiteCredits}` })
          .where(eq(livreurs.id, demande.livreurId))
          .returning();

        await db.insert(mouvementsCredit).values({
          livreurId: demande.livreurId,
          typeMouvement: "achat",
          quantite: demande.quantiteCredits,
          soldeApres: maj.credits,
          reference: demande.id,
          notes: `Achat de ${demande.quantiteCredits} crédit(s) — ${demande.montantPaye} FCFA`,
        });
      } else if (demande.ramasseurId) {
        const [maj] = await db
          .update(ramasseurs)
          .set({ credits: sql`${ramasseurs.credits} + ${demande.quantiteCredits}` })
          .where(eq(ramasseurs.id, demande.ramasseurId))
          .returning();

        await db.insert(mouvementsCredit).values({
          ramasseurId: demande.ramasseurId,
          typeMouvement: "achat",
          quantite: demande.quantiteCredits,
          soldeApres: maj.credits,
          reference: demande.id,
          notes: `Achat de ${demande.quantiteCredits} crédit(s) — ${demande.montantPaye} FCFA`,
        });
      } else if (demande.societeLivraisonId) {
        const [maj] = await db
          .update(societesLivraison)
          .set({ credits: sql`${societesLivraison.credits} + ${demande.quantiteCredits}` })
          .where(eq(societesLivraison.id, demande.societeLivraisonId))
          .returning();

        await db.insert(mouvementsCredit).values({
          societeLivraisonId: demande.societeLivraisonId,
          typeMouvement: "achat",
          quantite: demande.quantiteCredits,
          soldeApres: maj.credits,
          reference: demande.id,
          notes: `Achat de ${demande.quantiteCredits} crédit(s) — ${demande.montantPaye} FCFA`,
        });
      }

      return demande;
    }),

  rejeterDemandeCredit: adminProcedure
    .input(z.object({ demandeId: z.string().uuid() }))
    .mutation(async ({ input }) => {
      const [demande] = await db
        .update(demandesCredit)
        .set({ statut: "rejetee", traiteeAt: new Date() })
        .where(and(eq(demandesCredit.id, input.demandeId), eq(demandesCredit.statut, "en_attente")))
        .returning();

      if (!demande) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Demande introuvable ou déjà traitée",
        });
      }

      return demande;
    }),

  // ============================================================
  // NETTOYAGE DES DONNÉES DE TEST
  // ============================================================
  // Identifie comme "test" tout compte dont le nom (ou le nom de boutique/société)
  // contient le mot "test" (insensible à la casse) — c'est le motif utilisé par tous nos
  // scénarios de test (script automatisé, comptes créés manuellement pour vérifier une
  // fonctionnalité...). Toujours commencer par l'aperçu avant de confirmer la suppression.
  apercuNettoyageTest: adminProcedure.query(async () => {
    const boutiquesTest = await db
      .select({ id: boutiquesGaz.id, nom: boutiquesGaz.nomBoutique, gerant: utilisateurs.nom })
      .from(boutiquesGaz)
      .innerJoin(utilisateurs, eq(boutiquesGaz.utilisateurId, utilisateurs.id))
      .where(or(ilike(boutiquesGaz.nomBoutique, "%test%"), ilike(utilisateurs.nom, "%test%")));

    const livreursTest = await db
      .select({ id: livreurs.id, nom: utilisateurs.nom })
      .from(livreurs)
      .innerJoin(utilisateurs, eq(livreurs.utilisateurId, utilisateurs.id))
      .where(ilike(utilisateurs.nom, "%test%"));

    const ramasseursTest = await db
      .select({ id: ramasseurs.id, nom: utilisateurs.nom, nomSociete: ramasseurs.nomSociete })
      .from(ramasseurs)
      .innerJoin(utilisateurs, eq(ramasseurs.utilisateurId, utilisateurs.id))
      .where(or(ilike(utilisateurs.nom, "%test%"), ilike(ramasseurs.nomSociete, "%test%")));

    const clientsTest = await db
      .select({ id: utilisateurs.id, nom: utilisateurs.nom, telephone: utilisateurs.telephone })
      .from(utilisateurs)
      .where(and(eq(utilisateurs.role, "client"), ilike(utilisateurs.nom, "%test%")));

    const boutiqueIds = boutiquesTest.map((b) => b.id);
    const livreurIds = livreursTest.map((l) => l.id);
    const ramasseurIds = ramasseursTest.map((r) => r.id);
    const clientIds = clientsTest.map((c) => c.id);

    let nbCommandesGaz = 0;
    if (boutiqueIds.length || livreurIds.length || clientIds.length) {
      const conditions = [];
      if (boutiqueIds.length) conditions.push(inArray(commandesGaz.boutiqueId, boutiqueIds));
      if (livreurIds.length) conditions.push(inArray(commandesGaz.livreurId, livreurIds));
      if (clientIds.length) conditions.push(inArray(commandesGaz.clientId, clientIds));
      const [{ n }] = await db.select({ n: count() }).from(commandesGaz).where(or(...conditions));
      nbCommandesGaz = n;
    }

    let nbDemandesRamassage = 0;
    if (ramasseurIds.length || clientIds.length) {
      const conditions = [];
      if (ramasseurIds.length) conditions.push(inArray(demandesRamassage.ramasseurId, ramasseurIds));
      if (clientIds.length) conditions.push(inArray(demandesRamassage.clientId, clientIds));
      const [{ n }] = await db.select({ n: count() }).from(demandesRamassage).where(or(...conditions));
      nbDemandesRamassage = n;
    }

    return {
      boutiques: boutiquesTest.map((b) => ({ nom: b.nom, gerant: b.gerant })),
      livreurs: livreursTest.map((l) => ({ nom: l.nom })),
      ramasseurs: ramasseursTest.map((r) => ({ nom: r.nomSociete || r.nom })),
      clients: clientsTest.map((c) => ({ nom: c.nom, telephone: c.telephone })),
      nbCommandesGaz,
      nbDemandesRamassage,
    };
  }),

  nettoyerDonneesTest: adminProcedure
    .input(z.object({ confirmer: z.literal(true) }))
    .mutation(async () => {
      const boutiquesTest = await db
        .select({ id: boutiquesGaz.id })
        .from(boutiquesGaz)
        .innerJoin(utilisateurs, eq(boutiquesGaz.utilisateurId, utilisateurs.id))
        .where(or(ilike(boutiquesGaz.nomBoutique, "%test%"), ilike(utilisateurs.nom, "%test%")));

      const livreursTest = await db
        .select({ id: livreurs.id })
        .from(livreurs)
        .innerJoin(utilisateurs, eq(livreurs.utilisateurId, utilisateurs.id))
        .where(ilike(utilisateurs.nom, "%test%"));

      const ramasseursTest = await db
        .select({ id: ramasseurs.id })
        .from(ramasseurs)
        .innerJoin(utilisateurs, eq(ramasseurs.utilisateurId, utilisateurs.id))
        .where(or(ilike(utilisateurs.nom, "%test%"), ilike(ramasseurs.nomSociete, "%test%")));

      // utilisateurId des gérants/livreurs/ramasseurs test, récupérés séparément (nécessaire
      // pour purger leurs notifications/paiements avant de supprimer leur ligne utilisateurs)
      const boutiquesTestAvecUser = await db
        .select({ utilisateurId: boutiquesGaz.utilisateurId })
        .from(boutiquesGaz)
        .innerJoin(utilisateurs, eq(boutiquesGaz.utilisateurId, utilisateurs.id))
        .where(or(ilike(boutiquesGaz.nomBoutique, "%test%"), ilike(utilisateurs.nom, "%test%")));
      const livreursTestAvecUser = await db
        .select({ utilisateurId: livreurs.utilisateurId })
        .from(livreurs)
        .innerJoin(utilisateurs, eq(livreurs.utilisateurId, utilisateurs.id))
        .where(ilike(utilisateurs.nom, "%test%"));
      const ramasseursTestAvecUser = await db
        .select({ utilisateurId: ramasseurs.utilisateurId })
        .from(ramasseurs)
        .innerJoin(utilisateurs, eq(ramasseurs.utilisateurId, utilisateurs.id))
        .where(or(ilike(utilisateurs.nom, "%test%"), ilike(ramasseurs.nomSociete, "%test%")));

      const clientsTest = await db
        .select({ id: utilisateurs.id })
        .from(utilisateurs)
        .where(and(eq(utilisateurs.role, "client"), ilike(utilisateurs.nom, "%test%")));

      const boutiqueIds = boutiquesTest.map((b) => b.id);
      const livreurIds = livreursTest.map((l) => l.id);
      const ramasseurIds = ramasseursTest.map((r) => r.id);
      const clientIds = clientsTest.map((c) => c.id);

      const utilisateurIdsTest = [
        ...boutiquesTestAvecUser.map((b) => b.utilisateurId),
        ...livreursTestAvecUser.map((l) => l.utilisateurId),
        ...ramasseursTestAvecUser.map((r) => r.utilisateurId),
        ...clientIds,
      ].filter((id): id is string => !!id);

      // Commandes/demandes concernées, récupérées d'abord pour purger paiements avant
      const commandesGazTest =
        boutiqueIds.length || livreurIds.length || clientIds.length
          ? await db
              .select({ id: commandesGaz.id })
              .from(commandesGaz)
              .where(
                or(
                  ...[
                    boutiqueIds.length ? inArray(commandesGaz.boutiqueId, boutiqueIds) : undefined,
                    livreurIds.length ? inArray(commandesGaz.livreurId, livreurIds) : undefined,
                    clientIds.length ? inArray(commandesGaz.clientId, clientIds) : undefined,
                  ].filter((c): c is NonNullable<typeof c> => !!c)
                )
              )
          : [];

      const demandesRamassageTest =
        ramasseurIds.length || clientIds.length
          ? await db
              .select({ id: demandesRamassage.id })
              .from(demandesRamassage)
              .where(
                or(
                  ...[
                    ramasseurIds.length ? inArray(demandesRamassage.ramasseurId, ramasseurIds) : undefined,
                    clientIds.length ? inArray(demandesRamassage.clientId, clientIds) : undefined,
                  ].filter((c): c is NonNullable<typeof c> => !!c)
                )
              )
          : [];

      const commandeGazIds = commandesGazTest.map((c) => c.id);
      const demandeRamassageIds = demandesRamassageTest.map((d) => d.id);

      // Petit utilitaire : supprime uniquement si le tableau d'identifiants n'est pas vide
      // (inArray avec un tableau vide n'a rien à filtrer, on saute simplement l'étape)
      async function supprimerSi<T>(
        table: any,
        colonne: any,
        ids: T[],
        colonne2?: any,
        ids2?: T[]
      ) {
        if (colonne2 && ids2 && ids2.length) {
          if (ids.length) {
            await db.delete(table).where(or(inArray(colonne, ids), inArray(colonne2, ids2)));
          } else {
            await db.delete(table).where(inArray(colonne2, ids2));
          }
          return;
        }
        if (ids.length) {
          await db.delete(table).where(inArray(colonne, ids));
        }
      }

      // Ordre strict imposé par les clés étrangères : le plus dépendant en premier.
      await supprimerSi(mouvementsCredit, mouvementsCredit.livreurId, livreurIds, mouvementsCredit.ramasseurId, ramasseurIds);
      await supprimerSi(demandesCredit, demandesCredit.livreurId, livreurIds, demandesCredit.ramasseurId, ramasseurIds);

      if (commandeGazIds.length) await db.delete(paiements).where(inArray(paiements.commandeGazId, commandeGazIds));
      if (demandeRamassageIds.length) await db.delete(paiements).where(inArray(paiements.demandeRamassageId, demandeRamassageIds));
      if (utilisateurIdsTest.length) await db.delete(paiements).where(inArray(paiements.utilisateurId, utilisateurIdsTest));

      await supprimerSi(notifications, notifications.utilisateurId, utilisateurIdsTest);
      await supprimerSi(mouvementsStock, mouvementsStock.boutiqueId, boutiqueIds);
      await supprimerSi(approvisionnements, approvisionnements.boutiqueId, boutiqueIds);
      await supprimerSi(fournisseurs, fournisseurs.boutiqueId, boutiqueIds);
      await supprimerSi(stockBoutique, stockBoutique.boutiqueId, boutiqueIds);
      await supprimerSi(commandesGaz, commandesGaz.id, commandeGazIds);
      await supprimerSi(demandesRamassage, demandesRamassage.id, demandeRamassageIds);
      await supprimerSi(boutiquesGaz, boutiquesGaz.id, boutiqueIds);
      await supprimerSi(livreurs, livreurs.id, livreurIds);
      await supprimerSi(ramasseurs, ramasseurs.id, ramasseurIds);
      await supprimerSi(utilisateurs, utilisateurs.id, utilisateurIdsTest);

      // Marques de gaz "test" : uniquement si plus aucune référence réelle ne les utilise
      // (protège toute marque test qui serait, par accident, encore liée à une vraie boutique).
      await db.execute(sql`
        DELETE FROM marques_gaz
        WHERE nom ILIKE '%test%'
          AND id NOT IN (SELECT marque_gaz_id FROM stock_boutique WHERE marque_gaz_id IS NOT NULL)
          AND id NOT IN (SELECT marque_gaz_id FROM approvisionnements WHERE marque_gaz_id IS NOT NULL)
      `);

      return {
        supprimes: {
          boutiques: boutiqueIds.length,
          livreurs: livreurIds.length,
          ramasseurs: ramasseurIds.length,
          clients: clientIds.length,
          commandesGaz: commandeGazIds.length,
          demandesRamassage: demandeRamassageIds.length,
        },
      };
    }),
});
