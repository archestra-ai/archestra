ALTER TABLE "service_account_tokens" ADD COLUMN "secret_id" uuid;--> statement-breakpoint
ALTER TABLE "service_accounts" ADD COLUMN "team_id" text;--> statement-breakpoint
ALTER TABLE "service_accounts" ADD COLUMN "is_system" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "service_account_tokens" ADD CONSTRAINT "service_account_tokens_secret_id_secret_id_fk" FOREIGN KEY ("secret_id") REFERENCES "public"."secret"("id") ON DELETE cascade ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "service_account_tokens" VALIDATE CONSTRAINT "service_account_tokens_secret_id_secret_id_fk";--> statement-breakpoint
ALTER TABLE "service_accounts" ADD CONSTRAINT "service_accounts_team_id_team_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."team"("id") ON DELETE set null ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "service_accounts" VALIDATE CONSTRAINT "service_accounts_team_id_team_id_fk";--> statement-breakpoint
-- drizzle-migration-linter: allow-breaking
-- drizzle-migration-linter: reason=partial unique index on a column added above, so every existing row is outside it
CREATE UNIQUE INDEX "service_account_tokens_platform_token_unique_idx" ON "service_account_tokens" USING btree ("service_account_id") WHERE "service_account_tokens"."secret_id" is not null;--> statement-breakpoint
CREATE INDEX "service_accounts_team_id_idx" ON "service_accounts" USING btree ("team_id");--> statement-breakpoint
-- drizzle-migration-linter: allow-breaking
-- drizzle-migration-linter: reason=partial unique index on a column added above with default false, so every existing row is outside it
CREATE UNIQUE INDEX "service_accounts_organization_id_system_unique_idx" ON "service_accounts" USING btree ("organization_id") WHERE "service_accounts"."is_system";
