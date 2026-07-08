-- Catch-up assignment backfill for deployments that upgraded before the
-- startup sandbox backfill (backfillNewSandboxToolsToAgents) existed.
--
-- Migration 0332 ran in the Helm pre-upgrade hook, BEFORE the app booted and
-- seeded the flag-gated sandbox/files tool rows — on the default upgrade path
-- (code runtime newly enabled by the 1.3.0 chart) it therefore assigned
-- nothing for those groups, and it skipped All-tools agents entirely. The
-- startup backfill added alongside this migration only fires when the seed
-- NEWLY creates the sandbox tool rows; deployments already running with the
-- runtime on have the rows, so the trigger has passed for them. This
-- migration closes exactly that gap; where the rows still don't exist
-- (runtime off) it matches nothing and the startup backfill takes over on a
-- later enablement.
--
-- Statement 1: sandbox runtime + persistent-files tools to every non-deleted
-- agent that goes through the create-time tool hooks — every agent kind and
-- BOTH tool modes, matching AgentModel.create and the startup backfill. An
-- All-tools agent advertises only assigned built-ins in chat, so it needs the
-- rows too; 0332's assumption that All-mode agents reach these tools
-- dynamically only holds for the search_tools/run_tool dispatch surface, not
-- top-level tools/list. Built-in system agents are skipped: they are seeded
-- via raw insert and deliberately bypass the create-time hooks.
--
-- Statement 2: skill tools to All-tools agents only. Custom-mode agents of
-- type 'agent' already got them from 0332; All-tools agents were skipped
-- there and instead had the skill tools pre-EXCLUDED by 0330 (cleaned up by
-- 0335), leaving them without the assignment that makes the tools top-level —
-- unlike newly created All-tools agents. The per-org skills opt-in is not
-- checked, for the same reason as 0332: startup enables it for every org.
--
-- One-shot semantics like 0332: a group tool removed from an agent before
-- this release is re-added once; removals afterwards are never fought. Tool
-- selection is scoped to the built-in Archestra catalog rows (the
-- tools_archestra_catalog_name_uidx predicate); short names are extracted
-- with regexp_replace(name, '^.*__', '') (greedy, strips up to the LAST '__',
-- matching the branding code's lastIndexOf("__")) so white-label branded
-- prefixes are handled; DISTINCT ON picks one canonical row (the oldest) per
-- short name in case dual-prefix duplicate rows exist.
WITH sandbox_tools AS (
  SELECT DISTINCT ON (regexp_replace("name", '^.*__', '')) "id"
  FROM "tools"
  WHERE "catalog_id" = '00000000-0000-4000-8000-000000000001'
    AND "agent_id" IS NULL
    AND "delegate_to_agent_id" IS NULL
    AND regexp_replace("name", '^.*__', '') IN (
      'run_command', 'download_file', 'upload_file',
      'search_files', 'read_file', 'save_file', 'edit_file', 'delete_file'
    )
  ORDER BY regexp_replace("name", '^.*__', ''), "created_at" ASC, "id" ASC
)
INSERT INTO "agent_tools" ("agent_id", "tool_id")
SELECT a."id", t."id"
FROM "agents" a
CROSS JOIN sandbox_tools t
WHERE a."deleted_at" IS NULL
  AND a."built_in_agent_config" IS NULL
ON CONFLICT DO NOTHING;
--> statement-breakpoint
WITH skill_tools AS (
  SELECT DISTINCT ON (regexp_replace("name", '^.*__', '')) "id"
  FROM "tools"
  WHERE "catalog_id" = '00000000-0000-4000-8000-000000000001'
    AND "agent_id" IS NULL
    AND "delegate_to_agent_id" IS NULL
    AND regexp_replace("name", '^.*__', '') IN (
      'list_skills', 'load_skill', 'create_skill', 'update_skill'
    )
  ORDER BY regexp_replace("name", '^.*__', ''), "created_at" ASC, "id" ASC
)
INSERT INTO "agent_tools" ("agent_id", "tool_id")
SELECT a."id", t."id"
FROM "agents" a
CROSS JOIN skill_tools t
WHERE a."deleted_at" IS NULL
  AND a."built_in_agent_config" IS NULL
  AND a."access_all_tools" = true
ON CONFLICT DO NOTHING;
