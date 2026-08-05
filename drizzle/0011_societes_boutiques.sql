ALTER TABLE "boutiques_gaz" ADD COLUMN "societe_livraison_id" uuid;--> statement-breakpoint
ALTER TABLE "mouvements_credit" ADD COLUMN "boutique_id" uuid;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "boutiques_gaz" ADD CONSTRAINT "boutiques_gaz_societe_livraison_id_societes_livraison_id_fk" FOREIGN KEY ("societe_livraison_id") REFERENCES "public"."societes_livraison"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "mouvements_credit" ADD CONSTRAINT "mouvements_credit_boutique_id_boutiques_gaz_id_fk" FOREIGN KEY ("boutique_id") REFERENCES "public"."boutiques_gaz"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
