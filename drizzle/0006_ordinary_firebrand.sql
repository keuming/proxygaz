ALTER TABLE "commandes_gaz" ADD COLUMN "mode_paiement" "mode_paiement";--> statement-breakpoint
ALTER TABLE "commandes_gaz" ADD COLUMN "encaisse" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "commandes_gaz" ADD COLUMN "encaisse_at" timestamp;