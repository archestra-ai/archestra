CREATE TABLE "virtual_api_key_team" (
	"virtual_api_key_id" uuid NOT NULL,
	"team_id" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "virtual_api_key_team_virtual_api_key_id_team_id_pk" PRIMARY KEY("virtual_api_key_id","team_id")
);
--> statement-breakpoint
ALTER TABLE "virtual_api_keys" ADD COLUMN "scope" text DEFAULT 'org' NOT NULL;--> statement-breakpoint
ALTER TABLE "virtual_api_keys" ADD COLUMN "author_id" text;--> statement-breakpoint
ALTER TABLE "virtual_api_key_team" ADD CONSTRAINT "virtual_api_key_team_virtual_api_key_id_virtual_api_keys_id_fk" FOREIGN KEY ("virtual_api_key_id") REFERENCES "public"."virtual_api_keys"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "virtual_api_key_team" ADD CONSTRAINT "virtual_api_key_team_team_id_team_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."team"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "virtual_api_keys" ADD CONSTRAINT "virtual_api_keys_author_id_user_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_virtual_api_key_scope" ON "virtual_api_keys" USING btree ("scope");--> statement-breakpoint
CREATE INDEX "idx_virtual_api_key_author_id" ON "virtual_api_keys" USING btree ("author_id");
--> statement-breakpoint
CREATE INDEX "idx_virtual_api_key_team_team_id" ON "virtual_api_key_team" USING btree ("team_id");
--> statement-breakpoint
UPDATE "chat_api_keys"
SET "scope" = 'org'
WHERE "scope" = 'org_wide';--> statement-breakpoint
DROP INDEX IF EXISTS "chat_api_keys_primary_org_wide_unique";--> statement-breakpoint
CREATE UNIQUE INDEX "chat_api_keys_primary_org_unique" ON "chat_api_keys" USING btree ("organization_id","provider","scope") WHERE "chat_api_keys"."is_primary" = true AND "chat_api_keys"."scope" = 'org';
--> statement-breakpoint
-- Split the legacy "llmProvider" custom-role resource into:
-- - llmProviderApiKey
-- - llmVirtualKey
-- - llmModel
--
-- Mapping rules:
-- - llmProvider:read -> read on all three resources
-- - llmProvider:create/update/delete/admin -> mirrored onto
--   llmProviderApiKey and llmVirtualKey where supported
-- - llmProvider:update -> llmModel:update
-- - llmProvider:create also grants llmVirtualKey:admin so prior creators
--   retain org-scoped virtual-key visibility management
UPDATE "organization_role"
SET "permission" = (
  (
    ("permission"::jsonb - 'llmProvider')
    || CASE
      WHEN "permission"::text LIKE '%"llmProvider":%'
      THEN jsonb_build_object(
        'llmProviderApiKey',
        (
          SELECT COALESCE(jsonb_agg(DISTINCT val), '[]'::jsonb)
          FROM (
            SELECT jsonb_array_elements_text(COALESCE(("permission"::jsonb)->'llmProviderApiKey', '[]'::jsonb)) AS val
            UNION
            SELECT legacy_action AS val
            FROM jsonb_array_elements_text(("permission"::jsonb)->'llmProvider') AS legacy(legacy_action)
            WHERE legacy_action IN ('read', 'create', 'update', 'delete', 'admin')
          ) combined
        ),
        'llmVirtualKey',
        (
          SELECT COALESCE(jsonb_agg(DISTINCT val), '[]'::jsonb)
          FROM (
            SELECT jsonb_array_elements_text(COALESCE(("permission"::jsonb)->'llmVirtualKey', '[]'::jsonb)) AS val
            UNION
            SELECT legacy_action AS val
            FROM jsonb_array_elements_text(("permission"::jsonb)->'llmProvider') AS legacy(legacy_action)
            WHERE legacy_action IN ('read', 'create', 'update', 'delete', 'admin')
            UNION
            SELECT 'admin' AS val
            WHERE EXISTS (
              SELECT 1
              FROM jsonb_array_elements_text(("permission"::jsonb)->'llmProvider') AS legacy(legacy_action)
              WHERE legacy_action = 'create'
            )
          ) combined
        ),
        'llmModel',
        (
          SELECT COALESCE(jsonb_agg(DISTINCT val), '[]'::jsonb)
          FROM (
            SELECT jsonb_array_elements_text(COALESCE(("permission"::jsonb)->'llmModel', '[]'::jsonb)) AS val
            UNION
            SELECT legacy_action AS val
            FROM jsonb_array_elements_text(("permission"::jsonb)->'llmProvider') AS legacy(legacy_action)
            WHERE legacy_action IN ('read', 'update')
          ) combined
        )
      )
      ELSE '{}'::jsonb
    END
  )
)::text
WHERE "permission"::text LIKE '%"llmProvider":%';
