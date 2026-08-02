ALTER TABLE "audit_logs" ADD COLUMN "impersonated_by" text;--> statement-breakpoint
-- Added NOT VALID then validated separately: audit_logs is write-hot, and
-- ADD CONSTRAINT ... VALIDATE takes a lock that blocks writes while it scans.
-- The column is new on this migration, so every existing row is NULL and the
-- validation cannot fail.
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_impersonated_by_user_id_fk" FOREIGN KEY ("impersonated_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "audit_logs" VALIDATE CONSTRAINT "audit_logs_impersonated_by_user_id_fk";
