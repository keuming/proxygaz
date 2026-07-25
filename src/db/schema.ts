import {
  pgTable,
  uuid,
  varchar,
  text,
  timestamp,
  decimal,
  integer,
  boolean,
  pgEnum,
  doublePrecision,
  jsonb,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";

// ============================================================
// ENUMS
// ============================================================

export const roleEnum = pgEnum("role", [
  "client",
  "boutique",
  "livreur",
  "ramasseur",
  "admin",
]);

export const typeRamasseurEnum = pgEnum("type_ramasseur", [
  "particulier",
  "societe",
]);

export const statutValidationEnum = pgEnum("statut_validation", [
  "en_attente",
  "valide",
  "rejete",
  "suspendu",
]);

export const statutCommandeGazEnum = pgEnum("statut_commande_gaz", [
  "en_attente",       // nouvelle commande, en recherche de boutique
  "confirmee",        // en préparation : boutique a confirmé et décrémenté son stock
  "en_livraison",
  "livree",
  "non_livree",       // tentative de livraison échouée (client absent, adresse erronée...)
  "annulee",
]);

export const typeMouvementStockEnum = pgEnum("type_mouvement_stock", [
  "entree_fournisseur", // réception d'un approvisionnement
  "vente",              // décrémenté suite à une commande confirmée
  "ajustement",         // correction manuelle par la boutique (inventaire)
  "retour",              // bouteille retournée / commande annulée après confirmation
]);

export const statutApprovisionnementEnum = pgEnum("statut_approvisionnement", [
  "commande",     // bon de commande envoyé au fournisseur, pas encore reçu
  "receptionne",  // marchandise reçue, stock incrémenté
  "annule",
]);

export const statutDemandeRamassageEnum = pgEnum("statut_demande_ramassage", [
  "en_attente",        // en attente qu'un ramasseur valide
  "validee",           // un ramasseur a pris la demande
  "en_cours",
  "terminee",
  "annulee",
]);

export const modePaiementEnum = pgEnum("mode_paiement", [
  "mobile_money",      // via HUB2 (Orange Money, MTN MoMo, Wave, Moov)
  "especes_livraison",
]);

export const statutPaiementEnum = pgEnum("statut_paiement", [
  "en_attente",
  "reussi",
  "echoue",
  "rembourse",
]);

export const typeServiceEnum = pgEnum("type_service", ["gaz", "ramassage"]);

// ============================================================
// UTILISATEURS
// ============================================================

export const utilisateurs = pgTable("utilisateurs", {
  id: uuid("id").defaultRandom().primaryKey(),
  nom: varchar("nom", { length: 120 }).notNull(),
  telephone: varchar("telephone", { length: 20 }).notNull().unique(),
  email: varchar("email", { length: 160 }),
  motDePasseHash: varchar("mot_de_passe_hash", { length: 255 }).notNull(),
  role: roleEnum("role").notNull().default("client"),
  ville: varchar("ville", { length: 100 }),
  commune: varchar("commune", { length: 100 }),
  adresseDefaut: text("adresse_defaut"),
  latitude: doublePrecision("latitude"),
  longitude: doublePrecision("longitude"),
  actif: boolean("actif").notNull().default(true),
  tentativesEchouees: integer("tentatives_echouees").notNull().default(0),
  verrouilleJusqua: timestamp("verrouille_jusqua"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// ============================================================
// MODULE GAZ
// ============================================================

// Marques de bouteilles disponibles en CI (référentiel)
export const marquesGaz = pgTable("marques_gaz", {
  id: uuid("id").defaultRandom().primaryKey(),
  nom: varchar("nom", { length: 60 }).notNull(), // ex: "Orybel", "SIR Gaz", "Petro Ivoire"
  taille: varchar("taille", { length: 10 }).notNull(), // "B6", "B12", "B18", "B27", "B38"
  prixConsigne: decimal("prix_consigne", { precision: 10, scale: 2 }), // caution bouteille si 1ere fois
  prixRecharge: decimal("prix_recharge", { precision: 10, scale: 2 }).notNull(),
  actif: boolean("actif").notNull().default(true),
});

// Boutiques / dépôts partenaires
export const boutiquesGaz = pgTable("boutiques_gaz", {
  id: uuid("id").defaultRandom().primaryKey(),
  utilisateurId: uuid("utilisateur_id").references(() => utilisateurs.id),
  nomBoutique: varchar("nom_boutique", { length: 150 }).notNull(),
  pays: varchar("pays", { length: 100 }).notNull().default("Côte d'Ivoire"),
  ville: varchar("ville", { length: 100 }).notNull(),
  commune: varchar("commune", { length: 100 }),
  quartier: varchar("quartier", { length: 100 }),
  adresse: text("adresse"),
  latitude: doublePrecision("latitude"),
  longitude: doublePrecision("longitude"),
  rayonLivraisonKm: doublePrecision("rayon_livraison_km").default(5),
  statutValidation: statutValidationEnum("statut_validation").default("en_attente"),
  noteMoyenne: doublePrecision("note_moyenne").default(0),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// Stock par boutique et par marque/taille
export const stockBoutique = pgTable("stock_boutique", {
  id: uuid("id").defaultRandom().primaryKey(),
  boutiqueId: uuid("boutique_id").references(() => boutiquesGaz.id).notNull(),
  marqueGazId: uuid("marque_gaz_id").references(() => marquesGaz.id).notNull(),
  quantiteDisponible: integer("quantite_disponible").notNull().default(0),
  quantitePleines: integer("quantite_pleines").notNull().default(0), // pour échange bouteille vide<->pleine
  seuilAlerte: integer("seuil_alerte").notNull().default(5), // déclenche une alerte réappro sous ce seuil
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// Fournisseurs d'une boutique (dépôts centraux, distributeurs de marques)
export const fournisseurs = pgTable("fournisseurs", {
  id: uuid("id").defaultRandom().primaryKey(),
  boutiqueId: uuid("boutique_id").references(() => boutiquesGaz.id).notNull(),
  nom: varchar("nom", { length: 150 }).notNull(),
  telephone: varchar("telephone", { length: 20 }),
  adresse: text("adresse"),
  actif: boolean("actif").notNull().default(true),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// Bons d'approvisionnement (commandes de réassort auprès d'un fournisseur)
export const approvisionnements = pgTable("approvisionnements", {
  id: uuid("id").defaultRandom().primaryKey(),
  boutiqueId: uuid("boutique_id").references(() => boutiquesGaz.id).notNull(),
  fournisseurId: uuid("fournisseur_id").references(() => fournisseurs.id).notNull(),
  marqueGazId: uuid("marque_gaz_id").references(() => marquesGaz.id).notNull(),
  quantite: integer("quantite").notNull(),
  prixAchatUnitaire: decimal("prix_achat_unitaire", { precision: 10, scale: 2 }),
  statut: statutApprovisionnementEnum("statut").notNull().default("commande"),
  dateCommande: timestamp("date_commande").defaultNow().notNull(),
  dateReception: timestamp("date_reception"),
});

// Registre des mouvements de stock (traçabilité complète, façon inventaire comptable)
export const mouvementsStock = pgTable("mouvements_stock", {
  id: uuid("id").defaultRandom().primaryKey(),
  boutiqueId: uuid("boutique_id").references(() => boutiquesGaz.id).notNull(),
  marqueGazId: uuid("marque_gaz_id").references(() => marquesGaz.id).notNull(),
  typeMouvement: typeMouvementStockEnum("type_mouvement").notNull(),
  quantite: integer("quantite").notNull(), // positif = entrée, négatif = sortie
  soldeApres: integer("solde_apres").notNull(),
  reference: varchar("reference", { length: 100 }), // id commande ou id approvisionnement lié
  notes: text("notes"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// Livreurs de bouteilles de gaz (distincts des ramasseurs d'ordures)
export const livreurs = pgTable("livreurs", {
  id: uuid("id").defaultRandom().primaryKey(),
  utilisateurId: uuid("utilisateur_id").references(() => utilisateurs.id).notNull(),
  vehicule: varchar("vehicule", { length: 60 }), // "moto", "tricycle", "camionnette"
  zonesCouvertes: jsonb("zones_couvertes").notNull().default([]), // ["Cocody", "Marcory", ...]
  pays: varchar("pays", { length: 100 }).notNull().default("Côte d'Ivoire"),
  ville: varchar("ville", { length: 100 }),
  commune: varchar("commune", { length: 100 }),
  quartier: varchar("quartier", { length: 100 }),
  latitude: doublePrecision("latitude"),
  longitude: doublePrecision("longitude"),
  statutValidation: statutValidationEnum("statut_validation").default("en_attente"),
  noteMoyenne: doublePrecision("note_moyenne").default(0),
  nombreLivraisons: integer("nombre_livraisons").notNull().default(0),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const commandesGaz = pgTable("commandes_gaz", {
  id: uuid("id").defaultRandom().primaryKey(),
  clientId: uuid("client_id").references(() => utilisateurs.id).notNull(),
  marqueGazId: uuid("marque_gaz_id").references(() => marquesGaz.id).notNull(),
  boutiqueId: uuid("boutique_id").references(() => boutiquesGaz.id),
  livreurId: uuid("livreur_id").references(() => livreurs.id), // null jusqu'à acceptation par un livreur
  quantite: integer("quantite").notNull().default(1),
  echangeBouteilleVide: boolean("echange_bouteille_vide").notNull().default(true),
  adresseLivraison: text("adresse_livraison").notNull(),
  latitude: doublePrecision("latitude"),
  longitude: doublePrecision("longitude"),
  prixTotal: decimal("prix_total", { precision: 10, scale: 2 }).notNull(),
  statut: statutCommandeGazEnum("statut").notNull().default("en_attente"),
  livreurNom: varchar("livreur_nom", { length: 120 }),
  livreurTelephone: varchar("livreur_telephone", { length: 20 }),
  modePaiement: modePaiementEnum("mode_paiement"), // choisi par le client au checkout
  encaisse: boolean("encaisse").notNull().default(false), // true dès que le montant est effectivement perçu
  encaisseAt: timestamp("encaisse_at"),
  notes: text("notes"),
  raisonNonLivraison: text("raison_non_livraison"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  confirmedAt: timestamp("confirmed_at"),
  livreeAt: timestamp("livree_at"),
});

// ============================================================
// MODULE RAMASSAGE (poubelles)
// ============================================================

export const ramasseurs = pgTable("ramasseurs", {
  id: uuid("id").defaultRandom().primaryKey(),
  utilisateurId: uuid("utilisateur_id").references(() => utilisateurs.id).notNull(),
  type: typeRamasseurEnum("type").notNull().default("particulier"),
  nomSociete: varchar("nom_societe", { length: 150 }), // si type = societe
  zonesCouvertes: jsonb("zones_couvertes").notNull().default([]), // ["Cocody", "Marcory", ...]
  vehicule: varchar("vehicule", { length: 60 }), // "camion", "tricycle", "camionnette"
  pays: varchar("pays", { length: 100 }).notNull().default("Côte d'Ivoire"),
  ville: varchar("ville", { length: 100 }),
  commune: varchar("commune", { length: 100 }),
  quartier: varchar("quartier", { length: 100 }),
  latitude: doublePrecision("latitude"),
  longitude: doublePrecision("longitude"),
  statutValidation: statutValidationEnum("statut_validation").default("en_attente"),
  noteMoyenne: doublePrecision("note_moyenne").default(0),
  nombreRamassages: integer("nombre_ramassages").notNull().default(0),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const demandesRamassage = pgTable("demandes_ramassage", {
  id: uuid("id").defaultRandom().primaryKey(),
  clientId: uuid("client_id").references(() => utilisateurs.id).notNull(),
  ramasseurId: uuid("ramasseur_id").references(() => ramasseurs.id), // null jusqu'à validation
  adresse: text("adresse").notNull(),
  latitude: doublePrecision("latitude"),
  longitude: doublePrecision("longitude"),
  ville: varchar("ville", { length: 100 }).notNull(),
  commune: varchar("commune", { length: 100 }),
  typeDechet: varchar("type_dechet", { length: 60 }).default("menager"),
  quantiteEstimee: varchar("quantite_estimee", { length: 60 }), // "1 sac", "plusieurs sacs", "encombrants"
  prixPropose: decimal("prix_propose", { precision: 10, scale: 2 }),
  statut: statutDemandeRamassageEnum("statut").notNull().default("en_attente"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  validatedAt: timestamp("validated_at"),
  terminatedAt: timestamp("terminated_at"),
});

// ============================================================
// PAIEMENTS (HUB2 Mobile Money)
// ============================================================

export const paiements = pgTable("paiements", {
  id: uuid("id").defaultRandom().primaryKey(),
  utilisateurId: uuid("utilisateur_id").references(() => utilisateurs.id).notNull(),
  typeService: typeServiceEnum("type_service").notNull(),
  commandeGazId: uuid("commande_gaz_id").references(() => commandesGaz.id),
  demandeRamassageId: uuid("demande_ramassage_id").references(() => demandesRamassage.id),
  montant: decimal("montant", { precision: 10, scale: 2 }).notNull(),
  modePaiement: modePaiementEnum("mode_paiement").notNull(),
  operateur: varchar("operateur", { length: 40 }), // "orange_money", "mtn_momo", "wave", "moov_money"
  hub2TransactionId: varchar("hub2_transaction_id", { length: 100 }),
  hub2Reference: varchar("hub2_reference", { length: 100 }),
  statut: statutPaiementEnum("statut").notNull().default("en_attente"),
  rawResponse: jsonb("raw_response"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// ============================================================
// NOTIFICATIONS
// ============================================================

export const notifications = pgTable("notifications", {
  id: uuid("id").defaultRandom().primaryKey(),
  utilisateurId: uuid("utilisateur_id").references(() => utilisateurs.id).notNull(),
  titre: varchar("titre", { length: 150 }).notNull(),
  message: text("message").notNull(),
  type: varchar("type", { length: 40 }), // "commande_gaz", "ramassage", "paiement"
  lu: boolean("lu").notNull().default(false),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// ============================================================
// RELATIONS
// ============================================================

export const utilisateursRelations = relations(utilisateurs, ({ many }) => ({
  commandesGaz: many(commandesGaz),
  demandesRamassage: many(demandesRamassage),
  notifications: many(notifications),
}));

export const boutiquesGazRelations = relations(boutiquesGaz, ({ many, one }) => ({
  stock: many(stockBoutique),
  commandes: many(commandesGaz),
  utilisateur: one(utilisateurs, {
    fields: [boutiquesGaz.utilisateurId],
    references: [utilisateurs.id],
  }),
}));

export const commandesGazRelations = relations(commandesGaz, ({ one }) => ({
  client: one(utilisateurs, {
    fields: [commandesGaz.clientId],
    references: [utilisateurs.id],
  }),
  boutique: one(boutiquesGaz, {
    fields: [commandesGaz.boutiqueId],
    references: [boutiquesGaz.id],
  }),
  marque: one(marquesGaz, {
    fields: [commandesGaz.marqueGazId],
    references: [marquesGaz.id],
  }),
  livreur: one(livreurs, {
    fields: [commandesGaz.livreurId],
    references: [livreurs.id],
  }),
}));

export const livreursRelations = relations(livreurs, ({ one, many }) => ({
  utilisateur: one(utilisateurs, {
    fields: [livreurs.utilisateurId],
    references: [utilisateurs.id],
  }),
  commandes: many(commandesGaz),
}));

export const ramasseursRelations = relations(ramasseurs, ({ one, many }) => ({
  utilisateur: one(utilisateurs, {
    fields: [ramasseurs.utilisateurId],
    references: [utilisateurs.id],
  }),
  demandes: many(demandesRamassage),
}));

export const demandesRamassageRelations = relations(demandesRamassage, ({ one }) => ({
  client: one(utilisateurs, {
    fields: [demandesRamassage.clientId],
    references: [utilisateurs.id],
  }),
  ramasseur: one(ramasseurs, {
    fields: [demandesRamassage.ramasseurId],
    references: [ramasseurs.id],
  }),
}));

export const fournisseursRelations = relations(fournisseurs, ({ one, many }) => ({
  boutique: one(boutiquesGaz, {
    fields: [fournisseurs.boutiqueId],
    references: [boutiquesGaz.id],
  }),
  approvisionnements: many(approvisionnements),
}));

export const approvisionnementsRelations = relations(approvisionnements, ({ one }) => ({
  boutique: one(boutiquesGaz, {
    fields: [approvisionnements.boutiqueId],
    references: [boutiquesGaz.id],
  }),
  fournisseur: one(fournisseurs, {
    fields: [approvisionnements.fournisseurId],
    references: [fournisseurs.id],
  }),
  marque: one(marquesGaz, {
    fields: [approvisionnements.marqueGazId],
    references: [marquesGaz.id],
  }),
}));

export const mouvementsStockRelations = relations(mouvementsStock, ({ one }) => ({
  boutique: one(boutiquesGaz, {
    fields: [mouvementsStock.boutiqueId],
    references: [boutiquesGaz.id],
  }),
  marque: one(marquesGaz, {
    fields: [mouvementsStock.marqueGazId],
    references: [marquesGaz.id],
  }),
}));
