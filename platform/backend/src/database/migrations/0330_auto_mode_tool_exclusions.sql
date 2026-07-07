CREATE TABLE "agent_excluded_tools" (
	"agent_id" uuid NOT NULL,
	"tool_id" uuid NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "agent_excluded_tools_agent_id_tool_id_pk" PRIMARY KEY("agent_id","tool_id")
);
--> statement-breakpoint
ALTER TABLE "agent_excluded_tools" ADD CONSTRAINT "agent_excluded_tools_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "agent_excluded_tools" ADD CONSTRAINT "agent_excluded_tools_tool_id_tools_id_fk" FOREIGN KEY ("tool_id") REFERENCES "public"."tools"("id") ON DELETE cascade ON UPDATE no action NOT VALID;
--> statement-breakpoint
-- Data backfill: existing All-tools ("access all tools") agents keep exactly
-- today's behavior. Before this release, Archestra built-in tools reached an
-- All-mode agent only via an explicit agent_tools assignment; from now on the
-- whole built-in catalog is part of the All-mode surface minus exclusions. So
-- every built-in that is NOT currently assigned becomes an exclusion row —
-- except the always-available short names (search/run meta tools, sandbox +
-- file tools, query_knowledge_sources), which are never excluded. Tool names
-- carry a deployment-dependent brand prefix ("archestra__" or a branded slug),
-- so match on the short name after the last "__" like migrations 0285/0314 do.
-- ON CONFLICT DO NOTHING keeps it idempotent and preserves pre-existing rows.
INSERT INTO "agent_excluded_tools" (agent_id, tool_id)
SELECT a.id, t.id
FROM "agents" a
JOIN "tools" t
  ON t.catalog_id = '00000000-0000-4000-8000-000000000001'
  AND t.agent_id IS NULL
  AND t.delegate_to_agent_id IS NULL
WHERE a.access_all_tools = true
  AND regexp_replace(t.name, '^.*__', '') NOT IN (
    'search_tools',
    'run_tool',
    'run_command',
    'upload_file',
    'download_file',
    'search_files',
    'read_file',
    'save_file',
    'edit_file',
    'delete_file',
    'query_knowledge_sources'
  )
  AND NOT EXISTS (
    SELECT 1 FROM "agent_tools" at
    WHERE at.agent_id = a.id AND at.tool_id = t.id
  )
ON CONFLICT DO NOTHING;
