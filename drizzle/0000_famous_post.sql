CREATE TYPE "public"."mode_paiement" AS ENUM('mobile_money', 'especes_livraison');--> statement-breakpoint
CREATE TYPE "public"."role" AS ENUM('client', 'boutique', 'ramasseur', 'admin');--> statement-breakpoint
CREATE TYPE "public"."statut_commande_gaz" AS ENUM('en_attente', 'confirmee', 'en_livraison', 'livree', 'annulee');--> statement-breakpoint
CREATE TYPE "public"."statut_demande_ramassage" AS ENUM('en_attente', 'validee', 'en_cours', 'terminee', 'annulee');--> statement-breakpoint
CREATE TYPE "public"."statut_paiement" AS ENUM('en_attente', 'reussi', 'echoue', 'rembourse');--> statement-breakpoint
CREATE TYPE "public"."statut_validation" AS ENUM('en_attente', 'valide', 'rejete', 'suspendu');--> statement-breakpoint
CREATE TYPE "public"."type_ramasseur" AS ENUM('particulier', 'societe');--> statement-breakpoint
CREATE TYPE "public"."type_service" AS ENUM('gaz', 'ramassage');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "boutiques_gaz" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"utilisateur_id" uuid,
	"nom_boutique" varchar(150) NOT NULL,
	"ville" varchar(100) NOT NULL,
	"commune" varchar(100),
	"adresse" text,
	"latitude" double precision,
	"longitude" double precision,
	"rayon_livraison_km" double precision DEFAULT 5,
	"statut_validation" "statut_validation" DEFAULT 'en_attente',
	"note_moyenne" double precision DEFAULT 0,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "commandes_gaz" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid NOT NULL,
	"marque_gaz_id" uuid NOT NULL,
	"boutique_id" uuid,
	"quantite" integer DEFAULT 1 NOT NULL,
	"echange_bouteille_vide" boolean DEFAULT true NOT NULL,
	"adresse_livraison" text NOT NULL,
	"latitude" double precision,
	"longitude" double precision,
	"prix_total" numeric(10, 2) NOT NULL,
	"statut" "statut_commande_gaz" DEFAULT 'en_attente' NOT NULL,
	"livreur_nom" varchar(120),
	"livreur_telephone" varchar(20),
	"notes" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"confirmed_at" timestamp,
	"livree_at" timestamp
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "demandes_ramassage" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid NOT NULL,
	"ramasseur_id" uuid,
	"adresse" text NOT NULL,
	"latitude" double precision,
	"longitude" double precision,
	"ville" varchar(100) NOT NULL,
	"commune" varchar(100),
	"type_dechet" varchar(60) DEFAULT 'menager',
	"quantite_estimee" varchar(60),
	"prix_propose" numeric(10, 2),
	"statut" "statut_demande_ramassage" DEFAULT 'en_attente' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"validated_at" timestamp,
	"terminated_at" timestamp
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "marques_gaz" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"nom" varchar(60) NOT NULL,
	"taille" varchar(10) NOT NULL,
	"prix_consigne" numeric(10, 2),
	"prix_recharge" numeric(10, 2) NOT NULL,
	"actif" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"utilisateur_id" uuid NOT NULL,
	"titre" varchar(150) NOT NULL,
	"message" text NOT NULL,
	"type" varchar(40),
	"lu" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "paiements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"utilisateur_id" uuid NOT NULL,
	"type_service" "type_service" NOT NULL,
	"commande_gaz_id" uuid,
	"demande_ramassage_id" uuid,
	"montant" numeric(10, 2) NOT NULL,
	"mode_paiement" "mode_paiement" NOT NULL,
	"operateur" varchar(40),
	"hub2_transaction_id" varchar(100),
	"hub2_reference" varchar(100),
	"statut" "statut_paiement" DEFAULT 'en_attente' NOT NULL,
	"raw_response" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ramasseurs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"utilisateur_id" uuid NOT NULL,
	"type" "type_ramasseur" DEFAULT 'particulier' NOT NULL,
	"nom_societe" varchar(150),
	"zones_couvertes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"vehicule" varchar(60),
	"statut_validation" "statut_validation" DEFAULT 'en_attente',
	"note_moyenne" double precision DEFAULT 0,
	"nombre_ramassages" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "stock_boutique" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"boutique_id" uuid NOT NULL,
	"marque_gaz_id" uuid NOT NULL,
	"quantite_disponible" integer DEFAULT 0 NOT NULL,
	"quantite_pleines" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "utilisateurs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"nom" varchar(120) NOT NULL,
	"telephone" varchar(20) NOT NULL,
	"email" varchar(160),
	"mot_de_passe_hash" varchar(255) NOT NULL,
	"role" "role" DEFAULT 'client' NOT NULL,
	"ville" varchar(100),
	"commune" varchar(100),
	"adresse_defaut" text,
	"latitude" double precision,
	"longitude" double precision,
	"actif" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "utilisateurs_telephone_unique" UNIQUE("telephone")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "boutiques_gaz" ADD CONSTRAINT "boutiques_gaz_utilisateur_id_utilisateurs_id_fk" FOREIGN KEY ("utilisateur_id") REFERENCES "public"."utilisateurs"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "commandes_gaz" ADD CONSTRAINT "commandes_gaz_client_id_utilisateurs_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."utilisateurs"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "commandes_gaz" ADD CONSTRAINT "commandes_gaz_marque_gaz_id_marques_gaz_id_fk" FOREIGN KEY ("marque_gaz_id") REFERENCES "public"."marques_gaz"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "commandes_gaz" ADD CONSTRAINT "commandes_gaz_boutique_id_boutiques_gaz_id_fk" FOREIGN KEY ("boutique_id") REFERENCES "public"."boutiques_gaz"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "demandes_ramassage" ADD CONSTRAINT "demandes_ramassage_client_id_utilisateurs_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."utilisateurs"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "demandes_ramassage" ADD CONSTRAINT "demandes_ramassage_ramasseur_id_ramasseurs_id_fk" FOREIGN KEY ("ramasseur_id") REFERENCES "public"."ramasseurs"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "notifications" ADD CONSTRAINT "notifications_utilisateur_id_utilisateurs_id_fk" FOREIGN KEY ("utilisateur_id") REFERENCES "public"."utilisateurs"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "paiements" ADD CONSTRAINT "paiements_utilisateur_id_utilisateurs_id_fk" FOREIGN KEY ("utilisateur_id") REFERENCES "public"."utilisateurs"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "paiements" ADD CONSTRAINT "paiements_commande_gaz_id_commandes_gaz_id_fk" FOREIGN KEY ("commande_gaz_id") REFERENCES "public"."commandes_gaz"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "paiements" ADD CONSTRAINT "paiements_demande_ramassage_id_demandes_ramassage_id_fk" FOREIGN KEY ("demande_ramassage_id") REFERENCES "public"."demandes_ramassage"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ramasseurs" ADD CONSTRAINT "ramasseurs_utilisateur_id_utilisateurs_id_fk" FOREIGN KEY ("utilisateur_id") REFERENCES "public"."utilisateurs"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "stock_boutique" ADD CONSTRAINT "stock_boutique_boutique_id_boutiques_gaz_id_fk" FOREIGN KEY ("boutique_id") REFERENCES "public"."boutiques_gaz"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "stock_boutique" ADD CONSTRAINT "stock_boutique_marque_gaz_id_marques_gaz_id_fk" FOREIGN KEY ("marque_gaz_id") REFERENCES "public"."marques_gaz"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
