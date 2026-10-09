-- Remove the legacy guardrails: tool invocation policies, trusted data
-- policies, the Dual LLM workflow, and the `toolPolicy` RBAC resource.
-- OpenAPPA replaces all of them.
--
-- drizzle-migration-linter: allow-breaking
-- drizzle-migration-linter: reason=Every reader of these tables and columns
-- (policy routes and models, the proxy and gateway policy evaluation, Dual LLM
-- sanitization, chat approval claims, policy auto-configuration, and the
-- organization default-policy settings) is deleted in this same change, so no
-- reader is stranded during a rolling deploy. A separate contract release would
-- only leave orphan storage for a feature no supported version has.
--
-- The two `interactions` column drops are metadata-only (no rewrite, no index
-- references them); the lock timeout bounds the brief ACCESS EXCLUSIVE wait on
-- that write-hot table.
-- No CASCADE on the table drops: nothing references them, so an unexpected
-- dependant should fail loudly rather than be dropped.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
DROP TABLE "chat_tool_execution_claims";--> statement-breakpoint
DROP TABLE "tool_invocation_policies";--> statement-breakpoint
DROP TABLE "trusted_data_policies";--> statement-breakpoint
ALTER TABLE "agents" DROP COLUMN "consider_context_untrusted";--> statement-breakpoint
ALTER TABLE "interactions" DROP COLUMN "dual_llm_analyses";--> statement-breakpoint
ALTER TABLE "interactions" DROP COLUMN "unsafe_context_boundary";--> statement-breakpoint
ALTER TABLE "organization" DROP COLUMN "global_tool_policy";--> statement-breakpoint
ALTER TABLE "organization" DROP COLUMN "discovered_tool_policy";--> statement-breakpoint
ALTER TABLE "organization" DROP COLUMN "default_discovered_tool_invocation_policy";--> statement-breakpoint
ALTER TABLE "organization" DROP COLUMN "default_discovered_tool_result_policy";--> statement-breakpoint
ALTER TABLE "tools" DROP COLUMN "policies_auto_configured_at";--> statement-breakpoint
ALTER TABLE "tools" DROP COLUMN "policies_auto_configuring_started_at";--> statement-breakpoint
ALTER TABLE "tools" DROP COLUMN "policies_auto_configured_reasoning";--> statement-breakpoint
ALTER TABLE "tools" DROP COLUMN "policies_auto_configured_model";--> statement-breakpoint
-- Custom roles are frozen JSON permission snapshots; PermissionsSchema rejects
-- keys outside the resource enum, so strip the retired resource.
UPDATE "organization_role"
SET "permission" = ("permission"::jsonb - 'toolPolicy')::text,
  "updated_at" = now()
WHERE "permission"::jsonb ? 'toolPolicy';
--> statement-breakpoint
-- Retire the Policy Configuration Subagent and the Dual LLM Main/Quarantine
-- built-ins without deleting agent, tool, or usage history.
DELETE FROM "agent_tools"
WHERE "agent_id" IN (
  SELECT "id" FROM "agents" WHERE "built_in_agent_config"->>'name' IN ('policy-configuration-subagent', 'dual-llm-main-agent', 'dual-llm-quarantine-agent')
) OR "tool_id" IN (
  SELECT "id" FROM "tools" WHERE "delegate_to_agent_id" IN (
    SELECT "id" FROM "agents" WHERE "built_in_agent_config"->>'name' IN ('policy-configuration-subagent', 'dual-llm-main-agent', 'dual-llm-quarantine-agent')
  )
);
--> statement-breakpoint
DELETE FROM "agent_excluded_subagents"
WHERE "agent_id" IN (
  SELECT "id" FROM "agents" WHERE "built_in_agent_config"->>'name' IN ('policy-configuration-subagent', 'dual-llm-main-agent', 'dual-llm-quarantine-agent')
) OR "target_agent_id" IN (
  SELECT "id" FROM "agents" WHERE "built_in_agent_config"->>'name' IN ('policy-configuration-subagent', 'dual-llm-main-agent', 'dual-llm-quarantine-agent')
);
--> statement-breakpoint
UPDATE "tools" SET "deleted_at" = coalesce("deleted_at", now())
WHERE "delegate_to_agent_id" IN (
  SELECT "id" FROM "agents" WHERE "built_in_agent_config"->>'name' IN ('policy-configuration-subagent', 'dual-llm-main-agent', 'dual-llm-quarantine-agent')
);
--> statement-breakpoint
UPDATE "agents"
SET "deleted_at" = coalesce("deleted_at", now()), "built_in_agent_config" = NULL
WHERE "built_in_agent_config"->>'name' IN ('policy-configuration-subagent', 'dual-llm-main-agent', 'dual-llm-quarantine-agent');
