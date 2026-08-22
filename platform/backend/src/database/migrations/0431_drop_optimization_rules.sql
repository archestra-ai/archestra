-- Remove the LLM optimization rules feature.
--
-- Rules rerouted a request to a cheaper model when its conditions matched. The
-- routes, model, RBAC resource, proxy evaluation step, and UI are all removed
-- in this change; this migration drops the storage and the leftover permission.
--
-- drizzle-migration-linter: allow-breaking
-- drizzle-migration-linter: reason=The only code that reads this table (the
-- optimization-rule routes, the proxy's model-selection step, and the
-- audit-log hooks) is deleted in this same change, so there is no reader to
-- strand during a rolling deploy. Splitting this into a separate contract
-- release would leave an orphan table whose feature no longer exists in any
-- supported version.
--
-- No CASCADE: nothing references this table, and its own FK to `agents` was
-- dropped back in 0060 when rules moved to the generic entity_type/entity_id
-- pair. An unexpected dependant should fail loudly rather than be dropped.
DROP TABLE "optimization_rules";--> statement-breakpoint
-- Strip the now-unknown `optimizationRule` key from custom roles (frozen JSON
-- permission snapshots; predefined roles read their permissions from code).
-- PermissionsSchema rejects keys outside the resource enum, so a role left
-- carrying this one fails response validation and 500s the roles API.
-- LIKE keeps this compatible with PGlite (no jsonb `?` operator).
UPDATE "organization_role"
SET "permission" = ("permission"::jsonb - 'optimizationRule')::text
WHERE COALESCE("permission", '') LIKE '%"optimizationRule"%';
