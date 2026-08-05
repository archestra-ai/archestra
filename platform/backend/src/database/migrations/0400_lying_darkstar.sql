ALTER TABLE "conversations" ADD COLUMN "incognito" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "incognito_dek_fingerprint" text;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "incognito_escrow" jsonb;