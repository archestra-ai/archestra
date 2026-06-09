-- drizzle-migration-linter: allow-breaking
-- drizzle-migration-linter: reason=team_member duplicates are deduplicated below before adding the unique index; route code now rejects duplicate memberships.

DELETE FROM "team_member"
WHERE "id" IN (
  SELECT "id"
  FROM (
    SELECT
      "id",
      row_number() OVER (
        PARTITION BY "team_id", "user_id"
        ORDER BY "created_at" ASC, "id" ASC
      ) AS "duplicate_rank"
    FROM "team_member"
  ) "ranked_team_member"
  WHERE "duplicate_rank" > 1
);

CREATE UNIQUE INDEX "team_member_team_id_user_id_unique_idx" ON "team_member" USING btree ("team_id","user_id");
