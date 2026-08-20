-- `member.default_agent_id` used to be written implicitly: seeding, and every
-- creation path for a member's first personal chat agent, adopted that agent as
-- their personal default. Because the personal default outranks the
-- organization one when a chat picks its agent, every existing member silently
-- shadowed the organization's Default Agent setting with an agent they never
-- chose -- so an admin's default reached nobody, and chats (app chats included)
-- bound to a bare "My Assistant" instead.
--
-- The column now records a deliberate choice only (PUT /api/members/default-agent).
-- Clear the pointers that no choice ever produced:
--   (a) the member's oldest live personal chat agent -- exactly what the old
--       auto-adoption wrote, and indistinguishable from it after the fact, and
--   (b) anything that is not a live personal chat agent authored by that member
--       (soft-deleted or otherwise stale), which the resolver now ignores anyway.
--
-- A member who moved their default onto a *later* personal agent could only have
-- done so through the API, so those rows are kept.
UPDATE "member" AS m
SET "default_agent_id" = NULL
WHERE m."default_agent_id" IS NOT NULL
  AND (
    m."default_agent_id" = (
      SELECT a."id"
      FROM "agents" AS a
      WHERE a."organization_id" = m."organization_id"
        AND a."author_id" = m."user_id"
        AND a."agent_type" = 'agent'
        AND a."scope" = 'personal'
        AND a."built_in" = false
        AND a."deleted_at" IS NULL
      ORDER BY a."created_at" ASC, a."id" ASC
      LIMIT 1
    )
    OR NOT EXISTS (
      SELECT 1
      FROM "agents" AS a
      WHERE a."id" = m."default_agent_id"
        AND a."organization_id" = m."organization_id"
        AND a."author_id" = m."user_id"
        AND a."agent_type" = 'agent'
        AND a."scope" = 'personal'
        AND a."built_in" = false
        AND a."deleted_at" IS NULL
    )
  );
