ALTER TABLE "organization" ADD COLUMN "soft_delete_retention_days" integer DEFAULT 30 NOT NULL;--> statement-breakpoint
ALTER TABLE "organization" ADD COLUMN "soft_delete_auto_purge_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
CREATE INDEX "agents_deleted_org_idx" ON "agents" USING btree ("organization_id","deleted_at") WHERE "agents"."deleted_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "apps_deleted_org_idx" ON "apps" USING btree ("organization_id","deleted_at") WHERE "apps"."deleted_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "conversations_deleted_org_idx" ON "conversations" USING btree ("organization_id","deleted_at") WHERE "conversations"."deleted_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "projects_deleted_org_idx" ON "projects" USING btree ("organization_id","deleted_at") WHERE "projects"."deleted_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "skills_deleted_org_idx" ON "skills" USING btree ("organization_id","deleted_at") WHERE "skills"."deleted_at" IS NOT NULL;--> statement-breakpoint
-- A zero-day window would let the daily sweep invalidate an Undo the user was
-- just offered; "keep forever" is soft_delete_auto_purge_enabled, not a 0 here.
-- Added NOT VALID then validated separately: every existing row trivially
-- satisfies it (the column above is new, NOT NULL DEFAULT 30), and VALIDATE
-- takes a SHARE UPDATE EXCLUSIVE lock rather than blocking writes.
ALTER TABLE "organization" ADD CONSTRAINT "organization_soft_delete_retention_days_min_check" CHECK ("soft_delete_retention_days" >= 1) NOT VALID;--> statement-breakpoint
ALTER TABLE "organization" VALIDATE CONSTRAINT "organization_soft_delete_retention_days_min_check";