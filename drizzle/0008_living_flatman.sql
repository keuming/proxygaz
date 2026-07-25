CREATE TYPE "public"."statut_demande_credit" AS ENUM('en_attente', 'validee', 'rejetee');--> statement-breakpoint
CREATE TYPE "public"."type_mouvement_credit" AS ENUM('achat', 'debit_livraison', 'debit_ramassage', 'ajustement');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "demandes_credit" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"livreur_id" uuid,
	"ramasseur_id" uuid,
	"quantite_credits" integer NOT NULL,
	"montant_paye" numeric(10, 2) NOT NULL,
	"mode_paiement" "mode_paiement" DEFAULT 'mobile_money' NOT NULL,
	"reference_paiement" text,
	"statut" "statut_demande_credit" DEFAULT 'en_attente' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"traitee_at" timestamp
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "mouvements_credit" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"livreur_id" uuid,
	"ramasseur_id" uuid,
	"type_mouvement" "type_mouvement_credit" NOT NULL,
	"quantite" integer NOT NULL,
	"solde_apres" integer NOT NULL,
	"reference" varchar(100),
	"notes" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "livreurs" ADD COLUMN "credits" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "ramasseurs" ADD COLUMN "credits" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "demandes_credit" ADD CONSTRAINT "demandes_credit_livreur_id_livreurs_id_fk" FOREIGN KEY ("livreur_id") REFERENCES "public"."livreurs"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "demandes_credit" ADD CONSTRAINT "demandes_credit_ramasseur_id_ramasseurs_id_fk" FOREIGN KEY ("ramasseur_id") REFERENCES "public"."ramasseurs"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "mouvements_credit" ADD CONSTRAINT "mouvements_credit_livreur_id_livreurs_id_fk" FOREIGN KEY ("livreur_id") REFERENCES "public"."livreurs"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "mouvements_credit" ADD CONSTRAINT "mouvements_credit_ramasseur_id_ramasseurs_id_fk" FOREIGN KEY ("ramasseur_id") REFERENCES "public"."ramasseurs"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
