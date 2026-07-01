-- Collapse duplicate built-in Archestra catalog tools before enforcing uniqueness.
-- Built-in tools have agent_id/delegate_to_agent_id NULL, so the existing NULLS-DISTINCT
-- unique() never fired and duplicates accumulated. Keep the oldest (canonical, most-referenced)
-- row per (catalog_id, name), repoint assignments, copy the latest description, drop the rest.
-- Scoped to the Archestra catalog; inert policy rows on built-ins are removed with the
-- loser rows (Archestra tools bypass policy evaluation, so those rows are never used).

-- drizzle-migration-linter: allow-breaking
-- drizzle-migration-linter: reason=Archestra built-in tool duplicates are deduplicated below before adding the partial unique index; seedArchestraTools now upserts on the index.

-- Repoint agent assignments: drop loser rows where the agent already holds the survivor.
WITH ranked AS (
  SELECT id, first_value(id) OVER (
    PARTITION BY catalog_id, name, agent_id, delegate_to_agent_id
    ORDER BY created_at ASC, id ASC
  ) AS survivor_id
  FROM "tools"
  WHERE catalog_id = '00000000-0000-4000-8000-000000000001'
    and agent_id is null and delegate_to_agent_id is null
), remap AS (
  SELECT id AS loser_id, survivor_id FROM ranked WHERE id <> survivor_id
)
DELETE FROM "agent_tools" a
USING remap r
WHERE a.tool_id = r.loser_id
  AND EXISTS (
    SELECT 1 FROM "agent_tools" s
    WHERE s.agent_id = a.agent_id AND s.tool_id = r.survivor_id
  );
--> statement-breakpoint
WITH ranked AS (
  SELECT id, first_value(id) OVER (
    PARTITION BY catalog_id, name, agent_id, delegate_to_agent_id
    ORDER BY created_at ASC, id ASC
  ) AS survivor_id
  FROM "tools"
  WHERE catalog_id = '00000000-0000-4000-8000-000000000001'
    and agent_id is null and delegate_to_agent_id is null
), remap AS (
  SELECT id AS loser_id, survivor_id FROM ranked WHERE id <> survivor_id
)
UPDATE "agent_tools" a SET tool_id = r.survivor_id
FROM remap r WHERE a.tool_id = r.loser_id;
--> statement-breakpoint
WITH ranked AS (
  SELECT id, first_value(id) OVER (
    PARTITION BY catalog_id, name, agent_id, delegate_to_agent_id
    ORDER BY created_at ASC, id ASC
  ) AS survivor_id
  FROM "tools"
  WHERE catalog_id = '00000000-0000-4000-8000-000000000001'
    and agent_id is null and delegate_to_agent_id is null
), remap AS (
  SELECT id AS loser_id, survivor_id FROM ranked WHERE id <> survivor_id
)
DELETE FROM "conversation_enabled_tools" c
USING remap r
WHERE c.tool_id = r.loser_id
  AND EXISTS (
    SELECT 1 FROM "conversation_enabled_tools" s
    WHERE s.conversation_id = c.conversation_id AND s.tool_id = r.survivor_id
  );
--> statement-breakpoint
WITH ranked AS (
  SELECT id, first_value(id) OVER (
    PARTITION BY catalog_id, name, agent_id, delegate_to_agent_id
    ORDER BY created_at ASC, id ASC
  ) AS survivor_id
  FROM "tools"
  WHERE catalog_id = '00000000-0000-4000-8000-000000000001'
    and agent_id is null and delegate_to_agent_id is null
), remap AS (
  SELECT id AS loser_id, survivor_id FROM ranked WHERE id <> survivor_id
)
UPDATE "conversation_enabled_tools" c SET tool_id = r.survivor_id
FROM remap r WHERE c.tool_id = r.loser_id;
--> statement-breakpoint
WITH ranked AS (
  SELECT
    first_value(id) OVER (
      PARTITION BY catalog_id, name, agent_id, delegate_to_agent_id
      ORDER BY created_at ASC, id ASC
    ) AS survivor_id,
    first_value(description) OVER (
      PARTITION BY catalog_id, name, agent_id, delegate_to_agent_id
      ORDER BY created_at DESC, id DESC
    ) AS latest_description
  FROM "tools"
  WHERE catalog_id = '00000000-0000-4000-8000-000000000001'
    and agent_id is null and delegate_to_agent_id is null
), grp AS (
  SELECT DISTINCT survivor_id, latest_description FROM ranked
)
UPDATE "tools" t SET description = g.latest_description
FROM grp g
WHERE t.id = g.survivor_id AND t.description IS DISTINCT FROM g.latest_description;
--> statement-breakpoint
WITH ranked AS (
  SELECT id, first_value(id) OVER (
    PARTITION BY catalog_id, name, agent_id, delegate_to_agent_id
    ORDER BY created_at ASC, id ASC
  ) AS survivor_id
  FROM "tools"
  WHERE catalog_id = '00000000-0000-4000-8000-000000000001'
    and agent_id is null and delegate_to_agent_id is null
)
DELETE FROM "tools" WHERE id IN (
  SELECT id FROM ranked WHERE id <> survivor_id
);
--> statement-breakpoint
CREATE UNIQUE INDEX "tools_archestra_catalog_name_uidx" ON "tools" USING btree ("catalog_id","name") WHERE "tools"."catalog_id" = '00000000-0000-4000-8000-000000000001' and "tools"."agent_id" is null and "tools"."delegate_to_agent_id" is null;
