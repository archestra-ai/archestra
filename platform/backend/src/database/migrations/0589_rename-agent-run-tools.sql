-- Rename the built-in agent-run tools and fold list_runs into list_agent_runs.
--
-- A tool whose new short name has no live built-in row yet is renamed in
-- place, so its id and every assignment and exclusion keep pointing at it.
-- A tool whose new name already exists is merged: its references move onto
-- the surviving row, which also inherits its exclusions.
--
-- list_runs only listed the caller's own runs; list_agent_runs can list
-- everyone's. So list_runs is deleted with its assignments and exclusions,
-- never carried over: own runs stay reachable through list_agent_runs'
-- mine_only, which needs no assignment. The prefix is branded per deployment, so rows are matched on the
-- short name after the last "__" (see 0527, 0553).
--
-- 0125 commits the migrator's transaction, so the mapping is a session-scoped
-- temp table rather than ON COMMIT DROP; it goes away when the migrator
-- disconnects (as in 0565).
CREATE TEMPORARY TABLE "_agent_run_tool_renames" AS
SELECT
  t."id" AS "old_id",
  t."name" AS "old_name",
  target."id" AS "target_id",
  COALESCE(
    target."name",
    regexp_replace(t."name", m."old_short" || '$', m."new_short")
  ) AS "new_name",
  m."old_short" <> 'list_runs' AS "carries_access"
FROM "tools" t
JOIN (
  VALUES
    ('start_run', 'start_agent_run'),
    ('get_run', 'get_agent_run'),
    ('steer_run', 'steer_agent_run'),
    ('cancel_run', 'cancel_agent_run'),
    ('post_run_message', 'post_agent_run_message'),
    ('post_run_file', 'post_agent_run_file'),
    ('list_runs', 'list_agent_runs')
) AS m("old_short", "new_short")
  ON regexp_replace(t."name", '^.*__', '') = m."old_short"
LEFT JOIN LATERAL (
  SELECT s."id", s."name"
  FROM "tools" s
  WHERE s."catalog_id" = '00000000-0000-4000-8000-000000000001'
    AND s."agent_id" IS NULL
    AND s."delegate_to_agent_id" IS NULL
    AND s."deleted_at" IS NULL
    AND regexp_replace(s."name", '^.*__', '') = m."new_short"
  ORDER BY s."created_at" ASC, s."id" ASC
  LIMIT 1
) target ON true
WHERE t."catalog_id" = '00000000-0000-4000-8000-000000000001'
  AND t."agent_id" IS NULL
  AND t."delegate_to_agent_id" IS NULL;
--> statement-breakpoint
-- Merges: drop an old-tool row when its owner already holds the survivor, or
-- an earlier-sorted old tool merging into the same survivor, so the repoint
-- below cannot violate the owner/tool uniqueness.
DELETE FROM "agent_tools" a
USING "_agent_run_tool_renames" r
WHERE a."tool_id" = r."old_id"
  AND r."target_id" IS NOT NULL
  AND r."carries_access"
  AND EXISTS (
    SELECT 1 FROM "agent_tools" keep
    LEFT JOIN "_agent_run_tool_renames" kr ON kr."old_id" = keep."tool_id"
    WHERE keep."agent_id" = a."agent_id"
      AND keep."tool_id" <> a."tool_id"
      AND (
        keep."tool_id" = r."target_id"
        OR (kr."target_id" = r."target_id" AND keep."tool_id" < a."tool_id")
      )
  );
--> statement-breakpoint
UPDATE "agent_tools" a SET "tool_id" = r."target_id"
FROM "_agent_run_tool_renames" r
WHERE a."tool_id" = r."old_id" AND r."target_id" IS NOT NULL
  AND r."carries_access";
--> statement-breakpoint
DELETE FROM "app_tools" a
USING "_agent_run_tool_renames" r
WHERE a."tool_id" = r."old_id"
  AND r."target_id" IS NOT NULL
  AND r."carries_access"
  AND EXISTS (
    SELECT 1 FROM "app_tools" keep
    LEFT JOIN "_agent_run_tool_renames" kr ON kr."old_id" = keep."tool_id"
    WHERE keep."app_id" = a."app_id"
      AND keep."tool_id" <> a."tool_id"
      AND (
        keep."tool_id" = r."target_id"
        OR (kr."target_id" = r."target_id" AND keep."tool_id" < a."tool_id")
      )
  );
--> statement-breakpoint
UPDATE "app_tools" a SET "tool_id" = r."target_id"
FROM "_agent_run_tool_renames" r
WHERE a."tool_id" = r."old_id" AND r."target_id" IS NOT NULL
  AND r."carries_access";
--> statement-breakpoint
DELETE FROM "conversation_enabled_tools" c
USING "_agent_run_tool_renames" r
WHERE c."tool_id" = r."old_id"
  AND r."target_id" IS NOT NULL
  AND r."carries_access"
  AND EXISTS (
    SELECT 1 FROM "conversation_enabled_tools" keep
    LEFT JOIN "_agent_run_tool_renames" kr ON kr."old_id" = keep."tool_id"
    WHERE keep."conversation_id" = c."conversation_id"
      AND keep."tool_id" <> c."tool_id"
      AND (
        keep."tool_id" = r."target_id"
        OR (kr."target_id" = r."target_id" AND keep."tool_id" < c."tool_id")
      )
  );
--> statement-breakpoint
UPDATE "conversation_enabled_tools" c SET "tool_id" = r."target_id"
FROM "_agent_run_tool_renames" r
WHERE c."tool_id" = r."old_id" AND r."target_id" IS NOT NULL
  AND r."carries_access";
--> statement-breakpoint
DELETE FROM "tool_observations" o
USING "_agent_run_tool_renames" r
WHERE o."tool_id" = r."old_id"
  AND r."target_id" IS NOT NULL
  AND r."carries_access"
  AND EXISTS (
    SELECT 1 FROM "tool_observations" keep
    LEFT JOIN "_agent_run_tool_renames" kr ON kr."old_id" = keep."tool_id"
    WHERE keep."user_id" = o."user_id"
      AND keep."external_agent_id" = o."external_agent_id"
      AND keep."tool_id" <> o."tool_id"
      AND (
        keep."tool_id" = r."target_id"
        OR (kr."target_id" = r."target_id" AND keep."tool_id" < o."tool_id")
      )
  );
--> statement-breakpoint
UPDATE "tool_observations" o SET "tool_id" = r."target_id"
FROM "_agent_run_tool_renames" r
WHERE o."tool_id" = r."old_id" AND r."target_id" IS NOT NULL
  AND r."carries_access";
--> statement-breakpoint
UPDATE "a2a_outbound_runs" o SET "tool_id" = r."target_id"
FROM "_agent_run_tool_renames" r
WHERE o."tool_id" = r."old_id" AND r."target_id" IS NOT NULL;
--> statement-breakpoint
-- An exclusion only narrows access, so the survivor keeps its own and gains
-- the merged tool's. Everything else on a deleted row goes with it through
-- ON DELETE CASCADE.
INSERT INTO "agent_excluded_tools" ("agent_id", "tool_id")
SELECT e."agent_id", r."target_id"
FROM "agent_excluded_tools" e
JOIN "_agent_run_tool_renames" r ON r."old_id" = e."tool_id"
WHERE r."target_id" IS NOT NULL AND r."carries_access"
ON CONFLICT DO NOTHING;
--> statement-breakpoint
DELETE FROM "tools"
WHERE "id" IN (
  SELECT "old_id" FROM "_agent_run_tool_renames"
  WHERE "target_id" IS NOT NULL OR NOT "carries_access"
);
--> statement-breakpoint
UPDATE "tools" t SET "name" = r."new_name"
FROM "_agent_run_tool_renames" r
WHERE t."id" = r."old_id" AND r."target_id" IS NULL AND r."carries_access";
--> statement-breakpoint
-- Limits key tools by full name and only narrow access, so every one moves
-- to the new name.
UPDATE "limits" l SET "tool_name" = r."new_name"
FROM "_agent_run_tool_renames" r
WHERE l."tool_name" = r."old_name";
