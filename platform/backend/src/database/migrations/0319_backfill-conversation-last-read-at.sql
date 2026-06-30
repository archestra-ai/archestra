-- Custom SQL migration file, put your code below! --
-- Treat all existing conversations as read on deploy so the new sidebar
-- new-messages indicator doesn't light up the entire history at once.
-- Kept out of the ADD COLUMN migration (0318) on purpose: combining them would
-- hold the DDL's ACCESS EXCLUSIVE lock for the whole full-table rewrite. On its
-- own this UPDATE takes only row locks, so reads stay available during deploy.
-- Idempotent via the IS NULL guard.
UPDATE "conversations" SET "last_read_at" = "last_message_at" WHERE "last_read_at" IS NULL;