ALTER TABLE "member" ALTER COLUMN "role" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "organization_role" ADD COLUMN "title" text NOT NULL;--> statement-breakpoint

-- Add title column (nullable initially)
ALTER TABLE "organization_role" ADD COLUMN "title" text;--> statement-breakpoint
-- Backfill title with current name values
UPDATE "organization_role" SET "title" = "name";--> statement-breakpoint
-- Normalize name to lowercase without spaces for better-auth compatibility
UPDATE "organization_role" SET "name" = LOWER(REPLACE("name", ' ', ''));--> statement-breakpoint

ALTER TABLE "user" DROP COLUMN "role";
