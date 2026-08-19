-- drizzle-migration-linter: allow-breaking
-- drizzle-migration-linter: reason=brand-new table (role_resource_access); no existing rows, so its FK constraint and unique constraint cannot fail on any data. The data migration below only INSERTs into that new table.
CREATE TABLE "role_resource_access" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"role" text NOT NULL,
	"model_providers" text[],
	"knowledge_connectors" text[],
	"messaging_channels" text[],
	"connect_clients" text[],
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp,
	CONSTRAINT "role_resource_access_organization_id_role_unique" UNIQUE("organization_id","role")
);
--> statement-breakpoint
ALTER TABLE "role_resource_access" ADD CONSTRAINT "role_resource_access_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- Carry the organization-wide "page settings" allow-lists forward onto every
-- role that exists today, so an upgrade changes nobody's access.
--
-- The old model was one org-wide off switch per catalog entry
-- (`*_overrides` -> `hidden`) plus a connect-page client list. The new model is
-- a per-role allow-list where NULL means unrestricted. An organization that
-- never restricted anything therefore needs no rows at all — it stays
-- unrestricted, which is what "no list stored means everything is allowed"
-- buys us: nothing is locked out by the upgrade itself.
--
-- Rows are written for the four predefined role names as well as every custom
-- role: predefined roles have no `organization_role` row, yet "member" is the
-- role an organization most often restricts.
--
-- `connection_shown_providers` is deliberately NOT folded in. It only ever
-- narrowed which providers the connection page displayed, never which ones
-- could be configured; folding it into the single provider allow-list would
-- newly forbid providers that were merely absent from one page.
WITH catalog AS (
    SELECT
        ARRAY['openai','gemini','anthropic','bedrock','cohere','cerebras','mistral','perplexity','groq','xai','openrouter','vllm','ollama','ollama-native','zhipuai','deepseek','minimax','kimi','azure','github-copilot','microsoft-365-copilot','archestra']::text[] AS providers,
        ARRAY['jira','confluence','github','gitlab','notion','servicenow','sharepoint','gdrive','dropbox','onedrive','asana','linear','outline','salesforce','web_crawler','perforce','mfiles']::text[] AS connectors,
        ARRAY['slack','ms-teams','telegram','email','a2a']::text[] AS channels
), restricted AS (
    SELECT
        o.id AS organization_id,
        CASE WHEN EXISTS (
            SELECT 1 FROM jsonb_each(COALESCE(o.model_provider_overrides, '{}'::jsonb)) e
            WHERE e.value->>'hidden' = 'true'
        ) THEN COALESCE((
            SELECT array_agg(entry ORDER BY ord)
            FROM unnest(c.providers) WITH ORDINALITY AS t(entry, ord)
            WHERE COALESCE(o.model_provider_overrides -> entry ->> 'hidden', 'false') <> 'true'
        ), ARRAY[]::text[]) END AS model_providers,
        CASE WHEN EXISTS (
            SELECT 1 FROM jsonb_each(COALESCE(o.knowledge_connector_overrides, '{}'::jsonb)) e
            WHERE e.value->>'hidden' = 'true'
        ) THEN COALESCE((
            SELECT array_agg(entry ORDER BY ord)
            FROM unnest(c.connectors) WITH ORDINALITY AS t(entry, ord)
            WHERE COALESCE(o.knowledge_connector_overrides -> entry ->> 'hidden', 'false') <> 'true'
        ), ARRAY[]::text[]) END AS knowledge_connectors,
        CASE WHEN EXISTS (
            SELECT 1 FROM jsonb_each(COALESCE(o.messaging_channel_overrides, '{}'::jsonb)) e
            WHERE e.value->>'hidden' = 'true'
        ) THEN COALESCE((
            SELECT array_agg(entry ORDER BY ord)
            FROM unnest(c.channels) WITH ORDINALITY AS t(entry, ord)
            WHERE COALESCE(o.messaging_channel_overrides -> entry ->> 'hidden', 'false') <> 'true'
        ), ARRAY[]::text[]) END AS messaging_channels,
        o.connection_shown_client_ids AS connect_clients
    FROM "organization" o
    CROSS JOIN catalog c
)
INSERT INTO "role_resource_access" ("organization_id", "role", "model_providers", "knowledge_connectors", "messaging_channels", "connect_clients")
SELECT r.organization_id, roles.role, r.model_providers, r.knowledge_connectors, r.messaging_channels, r.connect_clients
FROM restricted r
CROSS JOIN LATERAL (
    SELECT unnest(ARRAY['admin','platform_admin','editor','member']) AS role
    UNION
    SELECT orr."role" FROM "organization_role" orr WHERE orr."organization_id" = r.organization_id
) roles
WHERE r.model_providers IS NOT NULL
   OR r.knowledge_connectors IS NOT NULL
   OR r.messaging_channels IS NOT NULL
   OR r.connect_clients IS NOT NULL
ON CONFLICT ("organization_id", "role") DO NOTHING;
