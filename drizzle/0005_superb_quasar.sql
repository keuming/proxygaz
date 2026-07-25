ALTER TABLE "livreurs" ADD COLUMN "pays" varchar(100) DEFAULT 'Côte d''Ivoire' NOT NULL;--> statement-breakpoint
ALTER TABLE "livreurs" ADD COLUMN "ville" varchar(100);--> statement-breakpoint
ALTER TABLE "livreurs" ADD COLUMN "commune" varchar(100);--> statement-breakpoint
ALTER TABLE "livreurs" ADD COLUMN "quartier" varchar(100);--> statement-breakpoint
ALTER TABLE "livreurs" ADD COLUMN "latitude" double precision;--> statement-breakpoint
ALTER TABLE "livreurs" ADD COLUMN "longitude" double precision;--> statement-breakpoint
ALTER TABLE "ramasseurs" ADD COLUMN "pays" varchar(100) DEFAULT 'Côte d''Ivoire' NOT NULL;--> statement-breakpoint
ALTER TABLE "ramasseurs" ADD COLUMN "ville" varchar(100);--> statement-breakpoint
ALTER TABLE "ramasseurs" ADD COLUMN "commune" varchar(100);--> statement-breakpoint
ALTER TABLE "ramasseurs" ADD COLUMN "quartier" varchar(100);--> statement-breakpoint
ALTER TABLE "ramasseurs" ADD COLUMN "latitude" double precision;--> statement-breakpoint
ALTER TABLE "ramasseurs" ADD COLUMN "longitude" double precision;