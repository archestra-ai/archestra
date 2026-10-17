-- Backfill agents.last_used_at: the later of each agent's newest mcp_tool_calls
-- row and its newest interactions row. GREATEST ignores nulls, so an agent
-- with neither keeps null (never used).
--
-- The aggregate runs first, before this migration takes any lock on agents
-- beyond a plain read. mcp_tool_calls is read once with a GROUP BY (it has no
-- (agent_id, created_at) index, so a per-agent max would walk its rows again
-- for every agent). interactions is read with one probe per agent of
-- interactions_profile_created_at_idx. Neither table is altered or locked for
-- writes. The ALTER and the keyed UPDATE that follow are short, and
-- lock_timeout bounds the wait for the ALTER's exclusive lock on agents.
--
-- On a fresh install this migration runs outside a transaction: migration
-- 0125 commits the migrator's transaction, so each later statement commits on
-- its own, and an ON COMMIT DROP table would be gone before the UPDATE. The
-- temp table is session-scoped instead and goes away when the migrator
-- disconnects.
CREATE TEMPORARY TABLE "_agent_last_used" AS
SELECT
  "agents"."id",
  GREATEST(
    "calls"."last_call_at",
    (
      SELECT max("interactions"."created_at")
      FROM "interactions"
      WHERE "interactions"."profile_id" = "agents"."id"
    )
  ) AS "last_used_at"
FROM "agents"
LEFT JOIN (
  SELECT "agent_id", max("created_at") AS "last_call_at"
  FROM "mcp_tool_calls"
  WHERE "agent_id" IS NOT NULL
  GROUP BY "agent_id"
) AS "calls" ON "calls"."agent_id" = "agents"."id";
--> statement-breakpoint
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "last_used_at" timestamp;
--> statement-breakpoint
-- A plain UPDATE does not run Drizzle's $onUpdate, so updated_at is unchanged.
UPDATE "agents"
SET "last_used_at" = "_agent_last_used"."last_used_at"
FROM "_agent_last_used"
WHERE "agents"."id" = "_agent_last_used"."id"
  AND "_agent_last_used"."last_used_at" IS NOT NULL;
