-- drizzle-migration-linter: allow-breaking
-- drizzle-migration-linter: reason=app_data belongs to the unreleased MCP Apps feature (ARCHESTRA_APPS_ENABLED, default off; no deployed writers or data). The dropped unique constraint is replaced by two stricter partial unique indexes that existing rows satisfy trivially: every existing row has user_id NULL, so the shared-partition index reproduces the old (app_id, key) uniqueness and the user-partition index matches no existing rows.
ALTER TABLE "app_data" DROP CONSTRAINT "app_data_app_id_key_unique";--> statement-breakpoint
DROP INDEX "app_data_app_id_idx";--> statement-breakpoint
ALTER TABLE "app_data" ADD COLUMN "user_id" text;--> statement-breakpoint
ALTER TABLE "app_data" ADD CONSTRAINT "app_data_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "app_data_app_id_user_id_idx" ON "app_data" USING btree ("app_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "app_data_shared_partition_key_idx" ON "app_data" USING btree ("app_id","key") WHERE "app_data"."user_id" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "app_data_user_partition_key_idx" ON "app_data" USING btree ("app_id","user_id","key") WHERE "app_data"."user_id" IS NOT NULL;