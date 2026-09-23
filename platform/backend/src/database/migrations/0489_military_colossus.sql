ALTER TABLE "knowledge_base_connectors" ADD COLUMN "sync_permissions_from_source" boolean DEFAULT false NOT NULL;--> statement-breakpoint
-- Connector permission sync gets its own switch. It used to be one value of
-- `visibility`, which also carried the retired org/team audience. Idempotent.
UPDATE "knowledge_base_connectors"
SET "sync_permissions_from_source" = true
WHERE "visibility" = 'auto-sync-permissions'
  AND "sync_permissions_from_source" = false;
