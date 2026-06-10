CREATE TABLE "github_app_configs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"github_url" text DEFAULT 'https://api.github.com' NOT NULL,
	"app_id" text NOT NULL,
	"installation_id" text NOT NULL,
	"secret_id" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "github_app_configs" ADD CONSTRAINT "github_app_configs_secret_id_secret_id_fk" FOREIGN KEY ("secret_id") REFERENCES "public"."secret"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "github_app_configs_organization_id_idx" ON "github_app_configs" USING btree ("organization_id");--> statement-breakpoint
-- Backfill: move existing GitHub App connectors' inline credentials into
-- shared github_app_configs rows, then repoint each connector at its new row.
--
-- For every connector authenticating via GitHub App we mint a github_app_configs
-- row that reuses the connector's existing private-key secret (we transfer
-- ownership of that secret to the new row). The connector's own secret_id is
-- nulled in the same statement so a later connector delete can never cascade
-- into the now-shared secret. Inline githubAppId/githubAppInstallationId fields
-- are dropped from the connector config in favor of githubAppConfigId.
DO $$
DECLARE
  conn RECORD;
  new_config_id uuid;
BEGIN
  FOR conn IN
    SELECT id, organization_id, secret_id, config, name
    FROM knowledge_base_connectors
    WHERE connector_type = 'github'
      AND config->>'authMethod' = 'github_app'
      -- skip incomplete rows so we never mint an unusable config: only backfill
      -- connectors carrying the full inline App credential set
      AND config ? 'githubAppId'
      AND config ? 'githubAppInstallationId'
      AND secret_id IS NOT NULL
  LOOP
    INSERT INTO github_app_configs (
      organization_id,
      name,
      github_url,
      app_id,
      installation_id,
      secret_id
    )
    VALUES (
      conn.organization_id,
      'Migrated from connector: ' || conn.name,
      COALESCE(conn.config->>'githubUrl', 'https://api.github.com'),
      COALESCE(conn.config->>'githubAppId', ''),
      COALESCE(conn.config->>'githubAppInstallationId', ''),
      conn.secret_id
    )
    RETURNING id INTO new_config_id;

    UPDATE knowledge_base_connectors
    SET config = (conn.config - 'githubAppId' - 'githubAppInstallationId')
                 || jsonb_build_object('githubAppConfigId', new_config_id::text),
        secret_id = NULL
    WHERE id = conn.id;
  END LOOP;
END $$;