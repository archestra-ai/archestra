-- Rename the built-in validation tools in place so their rows, and every
-- agent assignment that references them, survive the startup tool sync.
-- The prefix is branded per deployment, so match the suffix only.
UPDATE "tools"
SET "name" = regexp_replace("name", '__preview_openappa_validation_change$', '__preview_guardrails_validation_change')
WHERE "name" LIKE '%\_\_preview_openappa_validation_change'
  AND "catalog_id" = '00000000-0000-4000-8000-000000000001'
  AND "agent_id" IS NULL
  AND "delegate_to_agent_id" IS NULL;
--> statement-breakpoint
UPDATE "tools"
SET "name" = regexp_replace("name", '__publish_openappa_validation_change$', '__update_guardrails_validation')
WHERE "name" LIKE '%\_\_publish_openappa_validation_change'
  AND "catalog_id" = '00000000-0000-4000-8000-000000000001'
  AND "agent_id" IS NULL
  AND "delegate_to_agent_id" IS NULL;
