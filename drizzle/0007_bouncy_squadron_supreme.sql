ALTER TABLE "demandes_ramassage" ADD COLUMN "mode_paiement" "mode_paiement";--> statement-breakpoint
ALTER TABLE "demandes_ramassage" ADD COLUMN "encaisse" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "demandes_ramassage" ADD COLUMN "encaisse_at" timestamp;