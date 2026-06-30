-- Re-collapse built-in Archestra catalog tools that share a SHORT name but differ in
-- the branded prefix (e.g. "archestra__edit_file" vs "archestra_staging__edit_file").
-- Migration 0285 already did this once, but it is one-shot: dual-prefix rows recurred
-- afterwards because LLM-proxy auto-discovery (persistTools) recognized built-ins only
-- under the *current* brand, so a built-in handed to the proxy under the off-brand
-- prefix (e.g. chat routed through the proxy declaring `archestra__edit_file` while the
-- org is branded `archestra_staging`) was persisted as a shared proxy tool and then
-- promoted into the catalog as a duplicate. Those two leaks are fixed in this change
-- (persistTools now matches via archestraMcpBranding.isToolName, which accepts both
-- prefixes; seedArchestraTools promotion now dedups by short name), so this cleanup is
-- a one-time re-run with no recurrence.
--
-- Keep the oldest (canonical, most-referenced — typically the branded) row per short
-- name, repoint assignments, copy the latest description, and drop the rest, so the
-- next seed renames a single row with no unique-index collision. Scoped to built-in
-- Archestra catalog rows (agent_id / delegate_to_agent_id NULL). Identical strategy to
-- 0285.

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
    -- Drop this loser assignment when another row for the same agent already
    -- resolves to the survivor: the survivor itself, or an earlier-sorted loser
    -- in the same short-name group. Without this, three-plus siblings collide
    -- on agent_tools' unique(agent_id, tool_id) during the repoint UPDATE below.
    SELECT 1 FROM "agent_tools" keep
    LEFT JOIN remap kr ON kr.loser_id = keep.tool_id
    WHERE keep.agent_id = a.agent_id
      AND keep.tool_id <> a.tool_id
      AND COALESCE(kr.survivor_id, keep.tool_id) = r.survivor_id
      AND (
        keep.tool_id = r.survivor_id
        OR (kr.survivor_id IS NOT NULL AND keep.tool_id < a.tool_id)
      )
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
    -- Same loser-vs-loser guard as agent_tools, against the composite primary
    -- key (conversation_id, tool_id): keep one source row per conversation per
    -- short-name group so the repoint UPDATE cannot produce a duplicate.
    SELECT 1 FROM "conversation_enabled_tools" keep
    LEFT JOIN remap kr ON kr.loser_id = keep.tool_id
    WHERE keep.conversation_id = c.conversation_id
      AND keep.tool_id <> c.tool_id
      AND COALESCE(kr.survivor_id, keep.tool_id) = r.survivor_id
      AND (
        keep.tool_id = r.survivor_id
        OR (kr.survivor_id IS NOT NULL AND keep.tool_id < c.tool_id)
      )
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
