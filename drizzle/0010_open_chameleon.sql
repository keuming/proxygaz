ALTER TYPE "public"."role" ADD VALUE 'societe_livraison' BEFORE 'admin';--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "societes_livraison" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"utilisateur_id" uuid NOT NULL,
	"nom_societe" varchar(150) NOT NULL,
	"pays" varchar(100) DEFAULT 'Côte d''Ivoire' NOT NULL,
	"ville" varchar(100),
	"commune" varchar(100),
	"quartier" varchar(100),
	"latitude" double precision,
	"longitude" double precision,
	"statut_validation" "statut_validation" DEFAULT 'en_attente',
	"note_moyenne" double precision DEFAULT 0,
	"credits" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "demandes_credit" ADD COLUMN "societe_livraison_id" uuid;--> statement-breakpoint
ALTER TABLE "livreurs" ADD COLUMN "societe_livraison_id" uuid;--> statement-breakpoint
ALTER TABLE "mouvements_credit" ADD COLUMN "societe_livraison_id" uuid;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "societes_livraison" ADD CONSTRAINT "societes_livraison_utilisateur_id_utilisateurs_id_fk" FOREIGN KEY ("utilisateur_id") REFERENCES "public"."utilisateurs"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "demandes_credit" ADD CONSTRAINT "demandes_credit_societe_livraison_id_societes_livraison_id_fk" FOREIGN KEY ("societe_livraison_id") REFERENCES "public"."societes_livraison"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "livreurs" ADD CONSTRAINT "livreurs_societe_livraison_id_societes_livraison_id_fk" FOREIGN KEY ("societe_livraison_id") REFERENCES "public"."societes_livraison"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "mouvements_credit" ADD CONSTRAINT "mouvements_credit_societe_livraison_id_societes_livraison_id_fk" FOREIGN KEY ("societe_livraison_id") REFERENCES "public"."societes_livraison"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
