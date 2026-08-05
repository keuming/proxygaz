ALTER TABLE "ramasseurs" ADD COLUMN "societe_livraison_id" uuid;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ramasseurs" ADD CONSTRAINT "ramasseurs_societe_livraison_id_societes_livraison_id_fk" FOREIGN KEY ("societe_livraison_id") REFERENCES "public"."societes_livraison"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
