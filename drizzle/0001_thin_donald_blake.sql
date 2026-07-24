ALTER TYPE "public"."role" ADD VALUE 'livreur' BEFORE 'ramasseur';--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "livreurs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"utilisateur_id" uuid NOT NULL,
	"vehicule" varchar(60),
	"zones_couvertes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"statut_validation" "statut_validation" DEFAULT 'en_attente',
	"note_moyenne" double precision DEFAULT 0,
	"nombre_livraisons" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "commandes_gaz" ADD COLUMN "livreur_id" uuid;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "livreurs" ADD CONSTRAINT "livreurs_utilisateur_id_utilisateurs_id_fk" FOREIGN KEY ("utilisateur_id") REFERENCES "public"."utilisateurs"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "commandes_gaz" ADD CONSTRAINT "commandes_gaz_livreur_id_livreurs_id_fk" FOREIGN KEY ("livreur_id") REFERENCES "public"."livreurs"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
