ALTER TABLE "conversations" ADD COLUMN "deleted_at" timestamp;--> statement-breakpoint
-- Partial index for the hot sidebar list (owner-scoped, sorted by last activity,
-- active rows only). Created NON-concurrently because drizzle-kit runs each
-- migration inside a transaction, where CREATE INDEX CONCURRENTLY is disallowed.
-- On a fresh or small database this is instant. On a LARGE existing deployment,
-- build it out of band FIRST so this statement no-ops via IF NOT EXISTS, avoiding
-- the write-blocking lock a plain in-transaction CREATE INDEX would take (same
-- rule as archestra-dev-interactions-migrations):
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS "conversations_active_owner_last_message_idx"
--     ON "conversations" USING btree ("user_id","organization_id","last_message_at" DESC)
--     WHERE "deleted_at" IS NULL;
CREATE INDEX IF NOT EXISTS "conversations_active_owner_last_message_idx" ON "conversations" USING btree ("user_id","organization_id","last_message_at" desc) WHERE "conversations"."deleted_at" IS NULL;