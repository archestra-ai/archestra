-- Backfill the default built-in Archestra tool assignments (sandbox, files,
-- skills, apps groups) to every pre-existing agent of type 'agent'.
--
-- Newly created agents receive these groups via AgentModel.create's assign
-- hooks, but agents created before those hooks/tools shipped have no
-- agent_tools rows and cannot use the sandbox, chat file tools, skills, or app
-- authoring without manual assignment. This runs exactly once (Helm
-- pre-upgrade migration hook, before the app boots and seeds), so a user who
-- unassigns any of these tools later is never re-assigned by subsequent
-- deploys.
--
-- Only tool rows that already exist from previous releases are assigned:
-- skills/apps tools are always seeded; sandbox/files tools exist only if the
-- sandbox feature flag was on at last boot. Tool rows first introduced by a
-- later flag enablement are not retrofitted to old agents.
--
-- Tool selection is scoped to the built-in Archestra catalog rows only —
-- exactly the predicate of the tools_archestra_catalog_name_uidx partial
-- unique index — so same-named tools from external MCP servers are never
-- matched. Short names are extracted with regexp_replace(name, '^.*__', '')
-- (greedy, strips up to the LAST '__', matching the branding code's
-- lastIndexOf("__")) so white-label branded prefixes are handled. DISTINCT ON
-- picks one canonical row per short name (the oldest, as in 0285) in case
-- dual-prefix duplicate rows exist.
--
-- Skipped agents: other agent types (profile/mcp_gateway/llm_proxy),
-- soft-deleted agents, built-in system agents (built_in_agent_config IS NOT
-- NULL — seeded via raw insert, deliberately bypassing the create-time tool
-- hooks, so new ones don't get these tools either), and agents in Auto tool
-- mode (access_all_tools = true) — their tool surface is governed by
-- agent_excluded_tools instead of assignments, and they already reach the
-- sandbox/files tools dynamically. agent_excluded_tools is untouched.
WITH target_tools AS (
  SELECT DISTINCT ON (regexp_replace("name", '^.*__', '')) "id"
  FROM "tools"
  WHERE "catalog_id" = '00000000-0000-4000-8000-000000000001'
    AND "agent_id" IS NULL
    AND "delegate_to_agent_id" IS NULL
    AND regexp_replace("name", '^.*__', '') IN (
      'run_command', 'download_file', 'upload_file',
      'search_files', 'read_file', 'save_file', 'edit_file', 'delete_file',
      'list_skills', 'load_skill', 'create_skill', 'update_skill',
      'scaffold_app', 'refine_app', 'edit_app', 'set_app_tools', 'validate_app', 'publish_app',
      'read_app', 'preview_app_tool', 'get_app_diagnostics', 'render_app', 'list_apps', 'delete_app'
    )
  ORDER BY regexp_replace("name", '^.*__', ''), "created_at" ASC, "id" ASC
)
INSERT INTO "agent_tools" ("agent_id", "tool_id")
SELECT a."id", t."id"
FROM "agents" a
CROSS JOIN target_tools t
WHERE a."agent_type" = 'agent'
  AND a."deleted_at" IS NULL
  AND a."built_in_agent_config" IS NULL
  AND a."access_all_tools" = false
ON CONFLICT DO NOTHING;
