-- drizzle-migration-linter: allow-breaking
-- drizzle-migration-linter: reason=Battery packages become content-addressed. The dropped unique index on (organization_id, name) is replaced in this same migration by a plain index on the same columns, so listing keeps its index and only by-name uniqueness is given up (a name may now hold several versions). The new unique index on (organization_id, content_hash) cannot fail on existing data: the table holds at most one row per (organization_id, name) today and content_hash is derived from the package bytes, which carry the name, so no two existing rows of one organization share a hash. The table is operator-created and tiny (uploaded battery packages), so the non-concurrent index builds take no meaningful write lock.
DROP INDEX "openappa_battery_packages_org_name_idx";--> statement-breakpoint
ALTER TABLE "openappa_github_sync" ALTER COLUMN "repo" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "openappa_github_sync" ALTER COLUMN "path" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "openappa_battery_installs" ADD COLUMN "status" text DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE "openappa_battery_installs" ADD COLUMN "package_hash" text;--> statement-breakpoint
ALTER TABLE "openappa_battery_installs" ADD COLUMN "last_error" text;--> statement-breakpoint
ALTER TABLE "openappa_github_sync" ADD COLUMN "declarations_pending_publish" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "openappa_github_sync" ADD COLUMN "held_content" text;--> statement-breakpoint
ALTER TABLE "openappa_github_sync" ADD COLUMN "held_content_hash" text;--> statement-breakpoint
ALTER TABLE "openappa_github_sync" ADD COLUMN "held_source_commit" text;--> statement-breakpoint
ALTER TABLE "openappa_github_sync" ADD COLUMN "held_reasons" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "openappa_battery_packages_org_hash_idx" ON "openappa_battery_packages" USING btree ("organization_id","content_hash");--> statement-breakpoint
CREATE INDEX "openappa_battery_packages_org_name_list_idx" ON "openappa_battery_packages" USING btree ("organization_id","name");