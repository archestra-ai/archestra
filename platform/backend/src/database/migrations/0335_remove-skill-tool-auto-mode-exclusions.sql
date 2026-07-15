-- Remove the skill tools (list_skills, load_skill, create_skill,
-- update_skill) from agent exclusion lists.
--
-- Migration 0330 froze pre-existing All-tools ("access all tools") agents by
-- excluding every built-in tool they had no assignment for, exempting only
-- the search/run meta tools, the sandbox + file tools, and
-- query_knowledge_sources. Skill tools were missing from that exempt set, so
-- every pre-existing All-tools agent (including the built-in personal
-- assistant/gateway agents) got them pre-disabled — while newly created
-- agents get them assigned by AgentModel.create, and 0332's assignment
-- backfill skipped All-tools agents entirely. The shared
-- PREFILL_EXEMPT_ARCHESTRA_TOOL_SHORT_NAMES set now includes the skill
-- tools, which fixes every future pre-fill (agent creation, mode switch,
-- new-built-in seeding); this migration cleans up the rows the earlier
-- pre-fills already wrote.
--
-- One-shot semantics, like 0332: a skill tool an admin manually disabled
-- between the 0330 release and this one is re-enabled once; exclusions added
-- after this migration are never touched again.
--
-- Tool selection is scoped to the built-in Archestra catalog rows only (the
-- tools_archestra_catalog_name_uidx predicate), so same-named tools from
-- external MCP servers are never matched. Short names are extracted with
-- regexp_replace(name, '^.*__', '') (greedy, strips up to the LAST '__',
-- matching the branding code's lastIndexOf("__")) so white-label branded
-- prefixes are handled.
DELETE FROM "agent_excluded_tools" e
USING "tools" t
WHERE e."tool_id" = t."id"
  AND t."catalog_id" = '00000000-0000-4000-8000-000000000001'
  AND t."agent_id" IS NULL
  AND t."delegate_to_agent_id" IS NULL
  AND regexp_replace(t."name", '^.*__', '') IN (
    'list_skills', 'load_skill', 'create_skill', 'update_skill'
  );
