ALTER TABLE "organization_role" DROP CONSTRAINT "organization_role_organization_id_name_unique";--> statement-breakpoint
ALTER TABLE "organization_role" ALTER COLUMN "id" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "organization_role" ALTER COLUMN "id" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "organization_role" ADD COLUMN "role" text;--> statement-breakpoint
UPDATE "organization_role" SET "role" = "name";--> statement-breakpoint
ALTER TABLE "organization_role" ALTER COLUMN "role" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "organization_role" ADD CONSTRAINT "organization_role_organization_id_role_unique" UNIQUE("organization_id","role");--> statement-breakpoint
ALTER TABLE "invitation" ADD COLUMN "created_at" timestamp DEFAULT now() NOT NULL;--> statement-breakpoint
