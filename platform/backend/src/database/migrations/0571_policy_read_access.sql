-- SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
-- drizzle-migration-linter: allow-breaking
-- drizzle-migration-linter: reason=Adds three STORED generated columns to resource_permission_policies (scope_id, read_audience, read_subjects), derived by PostgreSQL from each row on every write, so no trigger or application code keeps them; the IMMUTABLE function they call; and partial indexes on the policies and on agents. Adding STORED generated columns REWRITES resource_permission_policies under ACCESS EXCLUSIVE, which blocks every permission check for the duration (one ALTER for all three columns, so one rewrite: measured in the PR on a 146k-policy dev database), followed by non-concurrent index builds that block writes to the indexed tables. Each statement stands on its own, so the migration is correct in one transaction and in autocommit (after 0125), and is safe to replay after a partial failure (CREATE OR REPLACE / IF NOT EXISTS). Old application code keeps working: it never names the new columns, and PostgreSQL computes them on writes by any version. Rolling the code back needs no data step.

-- Read access, derived from each policy row by PostgreSQL. `read_subjects`
-- lists every read grant's stored subject as `organization_id/type:id`; the
-- organization prefix keeps subjects that look alike across organizations
-- (`role:member`, `organization:*`) apart in the index. IMMUTABLE, as a
-- generated column requires: the result depends only on the arguments.
CREATE OR REPLACE FUNCTION resource_permission_read_subjects(organization_id text, grants jsonb)
RETURNS text[]
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT coalesce(
    array_agg(DISTINCT organization_id || '/' || (grant_entry->'subject'->>'type') || ':' || coalesce(grant_entry->'subject'->>'id', '')),
    '{}'
  )
  FROM jsonb_array_elements(
    CASE WHEN jsonb_typeof(grants) = 'array' THEN grants ELSE '[]'::jsonb END
  ) grant_entry
  WHERE (grant_entry->'actions') ? 'read'
    AND grant_entry->'subject'->>'type' IS NOT NULL
$$;
--> statement-breakpoint

-- The agents index first: it takes SHARE on agents, so agent reads go on,
-- and nothing here waits on the policies table.
CREATE INDEX IF NOT EXISTS "agents_catalog_created_idx" ON "agents" USING btree ("organization_id","agent_type","created_at" DESC NULLS FIRST,"name","id","author_id") WHERE "agents"."deleted_at" IS NULL AND NOT "agents"."built_in";
--> statement-breakpoint

-- The policy columns and their indexes last. Adding STORED generated
-- columns rewrites the table under ACCESS EXCLUSIVE, which every permission
-- check waits on; in one transaction that lock is held until commit, so
-- only the two policy indexes follow it. All three columns in one statement:
-- one rewrite.
ALTER TABLE "resource_permission_policies"
  ADD COLUMN IF NOT EXISTS "scope_id" uuid GENERATED ALWAYS AS (CASE WHEN "resource_permission_policies"."scope" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN "resource_permission_policies"."scope"::uuid END) STORED,
  ADD COLUMN IF NOT EXISTS "read_audience" text GENERATED ALWAYS AS (CASE
          WHEN "resource_permission_policies"."grants" @> '[{"subject":{"type":"organization"},"actions":["read"]}]'
            OR "resource_permission_policies"."grants" @> '[{"subject":{"type":"role"},"actions":["read"]}]' THEN 'org'
          WHEN "resource_permission_policies"."grants" @> '[{"subject":{"type":"team"},"actions":["read"]}]' THEN 'team'
          ELSE 'personal'
        END) STORED,
  ADD COLUMN IF NOT EXISTS "read_subjects" text[] GENERATED ALWAYS AS (resource_permission_read_subjects("resource_permission_policies"."organization_id", "resource_permission_policies"."grants")) STORED;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "resource_permission_policies_read_audience_idx" ON "resource_permission_policies" USING btree ("organization_id","resource","read_audience","scope_id") WHERE "resource_permission_policies"."scope_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "resource_permission_policies_read_subjects_idx" ON "resource_permission_policies" USING gin ("read_subjects") WHERE "resource_permission_policies"."scope_id" IS NOT NULL;
