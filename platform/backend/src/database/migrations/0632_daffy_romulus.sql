-- drizzle-migration-linter: allow-breaking
-- drizzle-migration-linter: reason=github_app_account is new and NULL on every existing row, and older releases never write it, so this partial unique index cannot fail existing data or refuse an older writer
ALTER TABLE "chat_api_keys" ADD COLUMN "github_app_account" text;--> statement-breakpoint
CREATE UNIQUE INDEX "chat_api_keys_github_app_account_unique" ON "chat_api_keys" USING btree ("organization_id","github_app_account") WHERE "chat_api_keys"."github_app_account" IS NOT NULL;