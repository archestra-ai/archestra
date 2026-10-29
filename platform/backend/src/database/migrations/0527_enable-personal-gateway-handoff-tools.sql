-- Remove the Agent Runtime handoff tools from personal MCP gateway exclusion
-- lists.
--
-- Personal gateways are created in All-tools ("access all tools") mode, and
-- the All-tools pre-fill excluded every built-in tool outside
-- PREFILL_EXEMPT_ARCHESTRA_TOOL_SHORT_NAMES. The handoff tools were not in
-- that set, so a fresh personal gateway could not discover or run
-- start_run, list_agents, or the workspace-file tools, and a local client
-- connected to it could not hand a session over to the runtime. The pre-fill
-- now exempts these tools on personal gateways; this migration cleans up the
-- rows earlier pre-fills already wrote.
--
-- One-shot semantics: a handoff tool a user manually disabled on their
-- personal gateway is re-enabled once; exclusions added after this migration
-- are never touched again. Other All-tools agents keep their exclusions.
--
-- Tool selection is scoped to the built-in Archestra catalog rows, and short
-- names are extracted with regexp_replace(name, '^.*__', '') so white-label
-- branded prefixes are handled (see 0335).
DELETE FROM "agent_excluded_tools" e
USING "tools" t, "agents" a
WHERE e."tool_id" = t."id"
  AND e."agent_id" = a."id"
  AND a."is_personal_gateway" = true
  AND t."catalog_id" = '00000000-0000-4000-8000-000000000001'
  AND t."agent_id" IS NULL
  AND t."delegate_to_agent_id" IS NULL
  AND regexp_replace(t."name", '^.*__', '') IN (
    'list_agents', 'start_run', 'get_run', 'list_runs', 'steer_run',
    'cancel_run', 'read_workspace_file', 'write_workspace_file',
    'transfer_workspace_file'
  );
