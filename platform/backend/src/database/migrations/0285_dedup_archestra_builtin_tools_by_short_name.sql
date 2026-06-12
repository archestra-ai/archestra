-- Collapse built-in Archestra catalog tools that share a SHORT name but differ in
-- the branded prefix (e.g. "archestra__search_tools" vs "archestra_staging__search_tools").
-- Migration 0283 and the tools_archestra_catalog_name_uidx index dedup by FULL name
-- (catalog_id, name), so dual-prefix rows from white-label rebrands survive side by side.
-- seedArchestraTools matches existing rows by short name and then renames one toward the
-- branded full name, which collides with its sibling and crashes startup. Keep the oldest
-- (canonical, most-referenced) row per short name, repoint assignments, copy the latest
-- description, and drop the rest so the next seed renames a single row with no collision.
-- Scoped to built-in Archestra catalog rows (agent_id / delegate_to_agent_id NULL).

-- Repoint agent assignments: drop loser rows where the agent already holds the survivor.
WITH ranked AS (
  SELECT id, first_value(id) OVER (
    PARTITION BY regexp_replace(name, '^.*__', '')
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
    PARTITION BY regexp_replace(name, '^.*__', '')
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
    PARTITION BY regexp_replace(name, '^.*__', '')
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
    PARTITION BY regexp_replace(name, '^.*__', '')
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
      PARTITION BY regexp_replace(name, '^.*__', '')
      ORDER BY created_at ASC, id ASC
    ) AS survivor_id,
    first_value(description) OVER (
      PARTITION BY regexp_replace(name, '^.*__', '')
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
    PARTITION BY regexp_replace(name, '^.*__', '')
    ORDER BY created_at ASC, id ASC
  ) AS survivor_id
  FROM "tools"
  WHERE catalog_id = '00000000-0000-4000-8000-000000000001'
    and agent_id is null and delegate_to_agent_id is null
)
DELETE FROM "tools" WHERE id IN (
  SELECT id FROM ranked WHERE id <> survivor_id
);
