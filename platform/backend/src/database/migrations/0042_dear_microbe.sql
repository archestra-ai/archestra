ALTER TABLE "organization" ADD COLUMN "theme" text DEFAULT 'cosmic-night' NOT NULL;--> statement-breakpoint
ALTER TABLE "organization" ADD COLUMN "custom_font" text DEFAULT 'lato' NOT NULL;--> statement-breakpoint
ALTER TABLE "organization" ADD COLUMN "logo_type" text DEFAULT 'default' NOT NULL;