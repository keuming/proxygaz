import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { eq, desc, count, and, sql, like, inArray } from "drizzle-orm";
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
  demandesCredit,
  mouvementsCredit,
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
        codePin: z.string().regex(/^\d{4}$/, "Le code PIN doit comporter exactement 4 chiffres"),
        pays: z.string().min(2).default("Côte d'Ivoire"),
        ville: z.string().min(2),
        commune: z.string().optional(),
        quartier: z.string().optional(),
        latitude: z.number().optional(),
        longitude: z.number().optional(),
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

      const [livreur] = await db
        .insert(livreurs)
        .values({
          utilisateurId: user.id,
          vehicule: input.vehicule,
          zonesCouvertes: input.zonesCouvertes,
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
        livreurId: livreur.id,
        typeMouvement: "ajustement",
        quantite: CREDITS_BIENVENUE,
        soldeApres: CREDITS_BIENVENUE,
        notes: "Crédits de bienvenue offerts à la création du compte",
      });

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
        codePin: z.string().regex(/^\d{4}$/, "Le code PIN doit comporter exactement 4 chiffres"),
        nomBoutique: z.string().min(2),
        pays: z.string().min(2).default("Côte d'Ivoire"),
        ville: z.string().min(2),
        commune: z.string().optional(),
        quartier: z.string().optional(),
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
});
