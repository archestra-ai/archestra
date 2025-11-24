ALTER TABLE "member" ALTER COLUMN "role" DROP NOT NULL;--> statement-breakpoint
-- Add title column (nullable initially)
ALTER TABLE "organization_role" ADD COLUMN "title" text;--> statement-breakpoint
-- Backfill title with current name values
UPDATE "organization_role" SET "title" = "name";--> statement-breakpoint
-- Normalize name to lowercase without spaces for better-auth compatibility
UPDATE "organization_role" SET "name" = LOWER(REPLACE("name", ' ', ''));--> statement-breakpoint
-- Also normalize member.role values to match the updated organization_role.name
UPDATE "member" SET "role" = LOWER(REPLACE("role", ' ', ''))
WHERE "role" NOT IN ('admin', 'member');--> statement-breakpoint
-- Make title required
ALTER TABLE "organization_role" ALTER COLUMN "title" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "user" DROP COLUMN "role";
