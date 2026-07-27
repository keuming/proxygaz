ALTER TABLE "livreurs" ADD COLUMN "position_actuelle_lat" double precision;--> statement-breakpoint
ALTER TABLE "livreurs" ADD COLUMN "position_actuelle_lng" double precision;--> statement-breakpoint
ALTER TABLE "livreurs" ADD COLUMN "position_maj_at" timestamp;--> statement-breakpoint
ALTER TABLE "ramasseurs" ADD COLUMN "position_actuelle_lat" double precision;--> statement-breakpoint
ALTER TABLE "ramasseurs" ADD COLUMN "position_actuelle_lng" double precision;--> statement-breakpoint
ALTER TABLE "ramasseurs" ADD COLUMN "position_maj_at" timestamp;