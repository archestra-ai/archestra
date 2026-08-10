-- Custom SQL migration file, put your code below! --

-- Collapse the built-in Advisor from one row per environment to a single
-- org-wide row (environment_id NULL). Delegation now carries an explicit
-- advisor exception across environment boundaries, so the per-environment
-- rows are no longer needed.
--
-- Soft-delete every environment-scoped advisor row. The org-wide (null-env)
-- row is left untouched; the boot seed reconciles it and inserts one for any
-- org that had only per-environment rows. Soft delete keeps this safe to run
-- as a pre-upgrade hook while the previous release still serves the proxy — a
-- removed row would block and then fail in-flight interaction inserts that
-- reference it — and leaves each retired row's history attributed in place.
--
-- The Advisor is a beta feature, so per-environment state that pointed at the
-- retired rows is deliberately not migrated: an agent that consulted the
-- advisor from a named environment loses that toggle and re-enables it against
-- the org-wide row, and a model configured on a named-environment advisor
-- falls back to the Default advisor's. Agents that consulted from the Default
-- environment keep their setting — that row survives.
UPDATE "agents" SET "deleted_at" = now()
WHERE "built_in_agent_config"->>'name' = 'advisor-agent'
  AND "environment_id" IS NOT NULL
  AND "deleted_at" IS NULL;
