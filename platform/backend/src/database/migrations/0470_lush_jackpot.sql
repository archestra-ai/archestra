-- drizzle-migration-linter: allow-breaking
-- drizzle-migration-linter: reason=Credential stores are consolidated in a coordinated upgrade with old application replicas stopped. Small configuration tables are renamed and migrated atomically; GitHub identifiers and secret handles are preserved before the old tables are removed. This release does not support mixed-version credential writers.
ALTER TABLE "runtime_credential_connections" RENAME TO "credential_connections";--> statement-breakpoint
ALTER TABLE "runtime_credential_definitions" RENAME TO "credential_definitions";--> statement-breakpoint
ALTER TABLE "credential_connections" DROP CONSTRAINT "runtime_credential_connections_scope_check";--> statement-breakpoint
ALTER TABLE "credential_connections" DROP CONSTRAINT "runtime_credential_connections_owner_check";--> statement-breakpoint
ALTER TABLE "credential_definitions" DROP CONSTRAINT "runtime_credential_definitions_scope_check";--> statement-breakpoint
ALTER TABLE "plugins" DROP CONSTRAINT "plugins_github_app_config_id_github_app_configs_id_fk";
--> statement-breakpoint
ALTER TABLE "plugins" DROP CONSTRAINT "plugins_github_pat_id_github_pats_id_fk";
--> statement-breakpoint
ALTER TABLE "credential_connections" DROP CONSTRAINT "runtime_credential_connections_user_id_user_id_fk";
--> statement-breakpoint
ALTER TABLE "credential_connections" DROP CONSTRAINT "runtime_credential_connections_secret_id_secret_id_fk";
--> statement-breakpoint
ALTER TABLE "credential_definitions" DROP CONSTRAINT "runtime_credential_definitions_created_by_user_id_fk";
--> statement-breakpoint
ALTER TABLE "credential_definitions" DROP CONSTRAINT "runtime_credential_definitions_created_by_service_account_id_service_accounts_id_fk";
--> statement-breakpoint
ALTER TABLE "skills" DROP CONSTRAINT "skills_github_app_config_id_github_app_configs_id_fk";
--> statement-breakpoint
ALTER TABLE "skills" DROP CONSTRAINT "skills_github_pat_id_github_pats_id_fk";
--> statement-breakpoint
DROP INDEX "runtime_credential_connections_org_idx";--> statement-breakpoint
DROP INDEX "runtime_credential_connections_user_idx";--> statement-breakpoint
DROP INDEX "runtime_credential_connections_personal_uidx";--> statement-breakpoint
DROP INDEX "runtime_credential_connections_organization_uidx";--> statement-breakpoint
DROP INDEX "runtime_credential_definitions_org_idx";--> statement-breakpoint
DROP INDEX "runtime_credential_definitions_org_key_uidx";--> statement-breakpoint
ALTER TABLE "credential_connections" ADD COLUMN "secret_key" text DEFAULT 'value' NOT NULL;--> statement-breakpoint
ALTER TABLE "credential_definitions" ADD COLUMN "kind" text DEFAULT 'secret' NOT NULL;--> statement-breakpoint
ALTER TABLE "credential_definitions" ADD COLUMN "github_url" text;--> statement-breakpoint
ALTER TABLE "credential_definitions" ADD COLUMN "app_id" text;--> statement-breakpoint
ALTER TABLE "credential_definitions" ADD COLUMN "installation_id" text;--> statement-breakpoint
-- Preserve identifiers and secret handles. Secret material stays in the configured manager.
INSERT INTO "credential_definitions" ("id", "organization_id", "key", "name", "kind", "allow_personal", "allow_organization", "github_url", "app_id", "installation_id", "created_at", "updated_at")
SELECT "id", "organization_id", 'github-app.' || "id"::text, "name", 'github_app', false, true, "github_url", "app_id", "installation_id", "created_at", "updated_at" FROM "github_app_configs";
--> statement-breakpoint
INSERT INTO "credential_definitions" ("id", "organization_id", "key", "name", "kind", "allow_personal", "allow_organization", "created_at", "updated_at")
SELECT "id", "organization_id", 'github-pat.' || "id"::text, "name", 'secret', false, true, "created_at", "updated_at" FROM "github_pats";
--> statement-breakpoint
INSERT INTO "credential_connections" ("organization_id", "scope", "credential_id", "secret_id", "secret_key", "created_at", "updated_at")
SELECT "organization_id", 'organization', 'github-app.' || "id"::text, "secret_id", 'apiToken', "created_at", "updated_at" FROM "github_app_configs" WHERE "secret_id" IS NOT NULL
UNION ALL
SELECT "organization_id", 'organization', 'github-pat.' || "id"::text, "secret_id", 'apiToken', "created_at", "updated_at" FROM "github_pats" WHERE "secret_id" IS NOT NULL;
--> statement-breakpoint
DROP TABLE "github_app_configs";
--> statement-breakpoint
DROP TABLE "github_pats";
--> statement-breakpoint
ALTER TABLE "plugins" ADD CONSTRAINT "plugins_github_app_config_id_credential_definitions_id_fk" FOREIGN KEY ("github_app_config_id") REFERENCES "public"."credential_definitions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plugins" ADD CONSTRAINT "plugins_github_pat_id_credential_definitions_id_fk" FOREIGN KEY ("github_pat_id") REFERENCES "public"."credential_definitions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credential_connections" ADD CONSTRAINT "credential_connections_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credential_connections" ADD CONSTRAINT "credential_connections_secret_id_secret_id_fk" FOREIGN KEY ("secret_id") REFERENCES "public"."secret"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credential_definitions" ADD CONSTRAINT "credential_definitions_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credential_definitions" ADD CONSTRAINT "credential_definitions_created_by_service_account_id_service_accounts_id_fk" FOREIGN KEY ("created_by_service_account_id") REFERENCES "public"."service_accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skills" ADD CONSTRAINT "skills_github_app_config_id_credential_definitions_id_fk" FOREIGN KEY ("github_app_config_id") REFERENCES "public"."credential_definitions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skills" ADD CONSTRAINT "skills_github_pat_id_credential_definitions_id_fk" FOREIGN KEY ("github_pat_id") REFERENCES "public"."credential_definitions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "credential_connections_org_idx" ON "credential_connections" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "credential_connections_user_idx" ON "credential_connections" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "credential_connections_personal_uidx" ON "credential_connections" USING btree ("organization_id","user_id","credential_id") WHERE "credential_connections"."scope" = 'personal';--> statement-breakpoint
CREATE UNIQUE INDEX "credential_connections_organization_uidx" ON "credential_connections" USING btree ("organization_id","credential_id") WHERE "credential_connections"."scope" = 'organization';--> statement-breakpoint
CREATE INDEX "credential_definitions_org_idx" ON "credential_definitions" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "credential_definitions_org_key_uidx" ON "credential_definitions" USING btree ("organization_id","key");--> statement-breakpoint
ALTER TABLE "credential_connections" ADD CONSTRAINT "credential_connections_scope_check" CHECK ("credential_connections"."scope" in ('personal', 'organization'));--> statement-breakpoint
ALTER TABLE "credential_connections" ADD CONSTRAINT "credential_connections_owner_check" CHECK (("credential_connections"."scope" = 'personal' and "credential_connections"."user_id" is not null) or ("credential_connections"."scope" = 'organization' and "credential_connections"."user_id" is null));--> statement-breakpoint
ALTER TABLE "credential_definitions" ADD CONSTRAINT "credential_definitions_scope_check" CHECK (("credential_definitions"."allow_personal" and not "credential_definitions"."allow_organization") or ("credential_definitions"."allow_organization" and not "credential_definitions"."allow_personal"));
--> statement-breakpoint
-- Preserve custom-role grants under the platform-wide permission resource.
UPDATE "organization_role"
SET "permission" = (("permission"::jsonb - 'githubAppConfig') || jsonb_build_object('credential', COALESCE("permission"::jsonb->'credential', "permission"::jsonb->'githubAppConfig')))::text
WHERE "permission"::jsonb ? 'githubAppConfig';

--> statement-breakpoint
-- Runtime credential administrators retain their existing management access.
UPDATE "organization_role"
SET "permission" = ("permission"::jsonb || jsonb_build_object('credential',
  CASE WHEN "permission"::jsonb->'agentSettings' @> '["update"]'::jsonb
    THEN '["create", "read", "update", "delete"]'::jsonb
    ELSE COALESCE("permission"::jsonb->'credential', '["read"]'::jsonb)
  END))::text
WHERE "permission"::jsonb->'agentSettings' @> '["read"]'::jsonb
   OR "permission"::jsonb->'agentSettings' @> '["update"]'::jsonb;
