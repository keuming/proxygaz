CREATE TYPE "public"."statut_approvisionnement" AS ENUM('commande', 'receptionne', 'annule');--> statement-breakpoint
CREATE TYPE "public"."type_mouvement_stock" AS ENUM('entree_fournisseur', 'vente', 'ajustement', 'retour');--> statement-breakpoint
ALTER TYPE "public"."statut_commande_gaz" ADD VALUE 'non_livree' BEFORE 'annulee';--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "approvisionnements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"boutique_id" uuid NOT NULL,
	"fournisseur_id" uuid NOT NULL,
	"marque_gaz_id" uuid NOT NULL,
	"quantite" integer NOT NULL,
	"prix_achat_unitaire" numeric(10, 2),
	"statut" "statut_approvisionnement" DEFAULT 'commande' NOT NULL,
	"date_commande" timestamp DEFAULT now() NOT NULL,
	"date_reception" timestamp
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "fournisseurs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"boutique_id" uuid NOT NULL,
	"nom" varchar(150) NOT NULL,
	"telephone" varchar(20),
	"adresse" text,
	"actif" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "mouvements_stock" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"boutique_id" uuid NOT NULL,
	"marque_gaz_id" uuid NOT NULL,
	"type_mouvement" "type_mouvement_stock" NOT NULL,
	"quantite" integer NOT NULL,
	"solde_apres" integer NOT NULL,
	"reference" varchar(100),
	"notes" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "commandes_gaz" ADD COLUMN "raison_non_livraison" text;--> statement-breakpoint
ALTER TABLE "stock_boutique" ADD COLUMN "seuil_alerte" integer DEFAULT 5 NOT NULL;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "approvisionnements" ADD CONSTRAINT "approvisionnements_boutique_id_boutiques_gaz_id_fk" FOREIGN KEY ("boutique_id") REFERENCES "public"."boutiques_gaz"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "approvisionnements" ADD CONSTRAINT "approvisionnements_fournisseur_id_fournisseurs_id_fk" FOREIGN KEY ("fournisseur_id") REFERENCES "public"."fournisseurs"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "approvisionnements" ADD CONSTRAINT "approvisionnements_marque_gaz_id_marques_gaz_id_fk" FOREIGN KEY ("marque_gaz_id") REFERENCES "public"."marques_gaz"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "fournisseurs" ADD CONSTRAINT "fournisseurs_boutique_id_boutiques_gaz_id_fk" FOREIGN KEY ("boutique_id") REFERENCES "public"."boutiques_gaz"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "mouvements_stock" ADD CONSTRAINT "mouvements_stock_boutique_id_boutiques_gaz_id_fk" FOREIGN KEY ("boutique_id") REFERENCES "public"."boutiques_gaz"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "mouvements_stock" ADD CONSTRAINT "mouvements_stock_marque_gaz_id_marques_gaz_id_fk" FOREIGN KEY ("marque_gaz_id") REFERENCES "public"."marques_gaz"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
