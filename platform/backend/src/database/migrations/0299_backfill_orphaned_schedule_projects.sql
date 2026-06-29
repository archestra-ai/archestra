-- Backfill: give every "orphaned" schedule trigger (project_id IS NULL) a home.
--
-- Background: 0294 moved Agent Schedules under Projects and added
-- schedule_triggers.project_id (all-NULL, no backfill). The standalone
-- Agent > Schedules screen was retired, so schedules are now reached only
-- through their owning project. Triggers created before 0294 (or while the
-- project link was still optional) have a NULL project_id and are therefore
-- invisible in the new project-scoped UI.
--
-- This migration creates one auto-generated project per (organization, owner)
-- that still has such orphaned triggers and repoints those triggers at it, so
-- they resurface where users now manage schedules. The trigger's actor (the
-- user it runs as) becomes the project owner, matching how creating a schedule
-- today also creates/owns its project.
WITH orphan_owners AS (
  SELECT
    organization_id,
    actor_user_id,
    -- A better-auth user can belong to more than one org; the (user_id, name)
    -- unique index forbids reusing one name across their projects, so number
    -- each owner's orgs and suffix all but the first.
    ROW_NUMBER() OVER (
      PARTITION BY actor_user_id
      ORDER BY organization_id
    ) AS owner_org_rank
  FROM schedule_triggers
  WHERE project_id IS NULL
  GROUP BY organization_id, actor_user_id
),
created_projects AS (
  INSERT INTO projects (
    id, organization_id, user_id, name, slug, description, created_at, updated_at
  )
  SELECT
    gen_random_uuid(),
    organization_id,
    actor_user_id,
    CASE
      WHEN owner_org_rank = 1 THEN 'Migrated Schedules'
      ELSE 'Migrated Schedules ' || owner_org_rank
    END,
    -- slug is the project's folder name and must be unique per org; a random
    -- suffix keeps it distinct when several owners migrate within one org.
    'migrated-schedules-' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 12),
    'Auto-generated when Agent Schedules moved into Projects. It holds scheduled tasks that previously had no project.',
    NOW(),
    NOW()
  FROM orphan_owners
  RETURNING id, organization_id, user_id
)
UPDATE schedule_triggers st
SET project_id = cp.id
FROM created_projects cp
WHERE st.project_id IS NULL
  AND st.organization_id = cp.organization_id
  AND st.actor_user_id = cp.user_id;
