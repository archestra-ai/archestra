-- Before member defaults became explicit-only, concurrent first-login requests
-- could each seed the same personal "My Assistant". Each request then wrote its
-- own row as the member default, so the pointer could land on any duplicate.
-- Migration 0426 cleared only the oldest live personal agent because it assumed
-- a later row could only have been selected deliberately. A pointer to a newer
-- generated duplicate therefore survived and continued to shadow the
-- organization default.
--
-- Clear only the unmistakable duplicate-seed shape. A single generated
-- assistant may have been deliberately pinned since 0426 and must be kept, as
-- must every custom personal-agent pin.
UPDATE "member" AS m
SET "default_agent_id" = NULL
FROM "agents" AS selected
WHERE m."default_agent_id" = selected."id"
  AND selected."organization_id" = m."organization_id"
  AND selected."author_id" = m."user_id"
  AND selected."agent_type" = 'agent'
  AND selected."scope" = 'personal'
  AND selected."built_in" = false
  AND selected."deleted_at" IS NULL
  AND selected."name" = 'My Assistant'
  AND selected."description" = 'Your personal chat assistant'
  AND EXISTS (
    SELECT 1
    FROM "agents" AS duplicate
    WHERE duplicate."id" <> selected."id"
      AND duplicate."organization_id" = selected."organization_id"
      AND duplicate."author_id" = selected."author_id"
      AND duplicate."agent_type" = 'agent'
      AND duplicate."scope" = 'personal'
      AND duplicate."built_in" = false
      AND duplicate."deleted_at" IS NULL
      AND duplicate."name" = selected."name"
      AND duplicate."description" = selected."description"
  );
