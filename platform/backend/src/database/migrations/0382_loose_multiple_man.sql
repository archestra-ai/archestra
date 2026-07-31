-- drizzle-migration-linter: allow-breaking
-- drizzle-migration-linter: reason=The drop and the create are one operation: the same projects_user_name_uidx narrowed by a predicate on deleted_at, a column this migration adds and which is therefore NULL on every existing row. The new index covers exactly the rows the old one did, so it cannot fail on existing data and no uniqueness guarantee is lost in between. projects is a small, low-write table, so the brief transactional lock is fine.
DROP INDEX "projects_user_name_uidx";--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "deleted_at" timestamp;--> statement-breakpoint
CREATE UNIQUE INDEX "projects_user_name_uidx" ON "projects" USING btree ("user_id","name") WHERE "projects"."deleted_at" IS NULL;