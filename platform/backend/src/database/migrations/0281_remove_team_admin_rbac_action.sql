-- Remove the legacy `team:admin` RBAC action from custom roles. Team-level
-- administration is now represented by the user's literal role on a team
-- membership row instead of an organization role permission.
WITH roles_with_team_admin AS (
  SELECT
    "organization_role"."id",
    COALESCE(
      jsonb_agg("team_action" ORDER BY "team_action")
        FILTER (WHERE "team_action" <> 'admin'),
      '[]'::jsonb
    ) AS "remaining_team_actions"
  FROM "organization_role"
  CROSS JOIN LATERAL jsonb_array_elements_text(
    COALESCE("organization_role"."permission"::jsonb->'team', '[]'::jsonb)
  ) AS "team_action"
  GROUP BY "organization_role"."id"
  HAVING bool_or("team_action" = 'admin')
)
UPDATE "organization_role"
SET
  "permission" = CASE
    WHEN jsonb_array_length("roles_with_team_admin"."remaining_team_actions") = 0
      THEN ("organization_role"."permission"::jsonb - 'team')::text
    ELSE jsonb_set(
      "organization_role"."permission"::jsonb,
      '{team}',
      "roles_with_team_admin"."remaining_team_actions"
    )::text
  END,
  "updated_at" = NOW()
FROM "roles_with_team_admin"
WHERE "organization_role"."id" = "roles_with_team_admin"."id";
--> statement-breakpoint

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
--> statement-breakpoint

CREATE UNIQUE INDEX "team_member_team_id_user_id_unique_idx" ON "team_member" USING btree ("team_id","user_id");
