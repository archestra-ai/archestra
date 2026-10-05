-- SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
-- Remove historical seeded assistants whose author is no longer a member.
-- The exact seed name and description are used only for this backfill because
-- older rows have no immutable seed marker. Preserve assistants still shared
-- with a current member or a broader audience.
UPDATE agents AS agent
SET deleted_at = now()
WHERE agent.deleted_at IS NULL
  AND agent.agent_type = 'agent'
  AND agent.built_in = false
  AND agent.name = 'My Assistant'
  AND agent.description = 'Your personal chat assistant'
  AND NOT EXISTS (
    SELECT 1 FROM member AS owner_member
    WHERE owner_member.organization_id = agent.organization_id
      AND owner_member.user_id = agent.author_id
  )
  AND NOT EXISTS (
    SELECT 1
    FROM resource_permission_policies AS policy,
      jsonb_array_elements(policy.grants) AS grant_entry
    WHERE policy.organization_id = agent.organization_id
      AND policy.resource = 'agent'
      AND policy.scope = agent.id::text
      AND ((grant_entry->'actions') ? 'read' OR (grant_entry->'actions') ? 'use')
      AND (
        grant_entry->'subject'->>'type' <> 'user'
        OR EXISTS (
          SELECT 1 FROM member AS recipient
          WHERE recipient.organization_id = agent.organization_id
            AND recipient.user_id = grant_entry->'subject'->>'id'
        )
      )
  );
