-- drizzle-migration-linter: allow-breaking
-- drizzle-migration-linter: reason=The foreign keys and the unique index target agent_identity_bindings, which this migration creates empty: the add-validating-constraint and add-unique-constraint rules scan no existing rows, and no older writer uses the table. The foreign keys only take a brief lock on agents and identity_provider to attach their triggers. The new mcp_tool_calls column is nullable with no default, so adding it rewrites no rows. agents.entra_agent_identity_id is copied, not dropped: the previous release keeps reading it until its pods are replaced.
CREATE TABLE "agent_identity_bindings" (
	"agent_id" uuid NOT NULL,
	"identity_provider_id" text NOT NULL,
	"external_id" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "agent_identity_bindings_agent_id_identity_provider_id_pk" PRIMARY KEY("agent_id","identity_provider_id")
);
--> statement-breakpoint
ALTER TABLE "mcp_tool_calls" ADD COLUMN "credential_actor_client_id" text;--> statement-breakpoint
ALTER TABLE "agent_identity_bindings" ADD CONSTRAINT "agent_identity_bindings_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_identity_bindings" ADD CONSTRAINT "agent_identity_bindings_identity_provider_id_identity_provider_id_fk" FOREIGN KEY ("identity_provider_id") REFERENCES "public"."identity_provider"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_identity_bindings_identity_provider_external_id_idx" ON "agent_identity_bindings" USING btree ("identity_provider_id",lower("external_id"));--> statement-breakpoint
-- Move each agent's Microsoft Entra agent identity to a binding on every
-- identity provider of its organization that has an Entra Agent ID blueprint:
-- those are the providers the old column was used with. oidc_config is JSON
-- text written by JSON.stringify (see migration 0210). The old column had no
-- unique constraint and soft-deleted agents kept their value, so two agents
-- can hold one identity: the live agent keeps it, else the oldest.
INSERT INTO "agent_identity_bindings" ("agent_id", "identity_provider_id", "external_id")
SELECT DISTINCT ON ("identity_provider"."id", lower(btrim("agents"."entra_agent_identity_id")))
  "agents"."id", "identity_provider"."id", btrim("agents"."entra_agent_identity_id")
FROM "agents"
JOIN "identity_provider"
  ON "identity_provider"."organization_id" = "agents"."organization_id"
WHERE "agents"."entra_agent_identity_id" IS NOT NULL
  AND btrim("agents"."entra_agent_identity_id") <> ''
  AND "identity_provider"."oidc_config" IS NOT NULL
  AND btrim(COALESCE(
    "identity_provider"."oidc_config"::jsonb #>> '{enterpriseManagedCredentials,entraAgentId,blueprintClientId}',
    ''
  )) <> ''
ORDER BY
  "identity_provider"."id",
  lower(btrim("agents"."entra_agent_identity_id")),
  "agents"."deleted_at" IS NOT NULL,
  "agents"."created_at",
  "agents"."id";--> statement-breakpoint
-- Report what was not carried over: a binding with no such provider, which
-- failed every tool call already, or one another agent kept.
DO $$
DECLARE
  dropped record;
BEGIN
  FOR dropped IN
    SELECT "agents"."id"
    FROM "agents"
    WHERE "agents"."entra_agent_identity_id" IS NOT NULL
      AND btrim("agents"."entra_agent_identity_id") <> ''
      AND NOT EXISTS (
        SELECT 1 FROM "agent_identity_bindings"
        WHERE "agent_identity_bindings"."agent_id" = "agents"."id"
      )
  LOOP
    RAISE NOTICE 'Agent % had a Microsoft Entra agent identity that was not carried over: no identity provider in its organization has Entra Agent ID configured, or another agent holds the same identity.', dropped."id";
  END LOOP;
END $$;
