ALTER TABLE "user" ADD COLUMN IF NOT EXISTS "soft_deleted" timestamp;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN IF NOT EXISTS "scim_provisioned" timestamp;