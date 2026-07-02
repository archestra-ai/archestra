-- Monotonic insertion-order for messages plus read/latest watermarks on
-- conversations. Two timestamp-tie bugs share this fix: "delete subsequent
-- messages" (strictly-greater created_at) and unread detection (a read
-- racing an incoming message in the same instant marks it read).
--
-- The obvious one-liner (ADD COLUMN ... DEFAULT nextval(...)) fills existing
-- rows in physical row order (volatile default => full-table rewrite), which
-- can disagree with created_at for historical rows. Instead: add the bare
-- column, backfill in (created_at, id) order, then attach the default for
-- new writes. Old writers keep inserting during rollout (default fires
-- server-side); NOT NULL is deferred to a later contract-phase migration per
-- the migration linter's expand/contract rule.
CREATE SEQUENCE "messages_seq_seq";--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "seq" bigint;--> statement-breakpoint
UPDATE "messages" m SET "seq" = sub.rn FROM (SELECT id, row_number() OVER (ORDER BY created_at, id) AS rn FROM "messages") sub WHERE m.id = sub.id;--> statement-breakpoint
SELECT setval('"messages_seq_seq"', COALESCE((SELECT MAX("seq") FROM "messages"), 0) + 1, false);--> statement-breakpoint
ALTER TABLE "messages" ALTER COLUMN "seq" SET DEFAULT nextval('messages_seq_seq');--> statement-breakpoint
ALTER SEQUENCE "messages_seq_seq" OWNED BY "messages"."seq";--> statement-breakpoint
CREATE INDEX "messages_conversation_id_seq_idx" ON "messages" USING btree ("conversation_id","seq");--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "last_message_seq" bigint;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "last_read_seq" bigint;--> statement-breakpoint
UPDATE "conversations" c SET "last_message_seq" = sub.max_seq FROM (SELECT conversation_id, MAX("seq") AS max_seq FROM "messages" GROUP BY conversation_id) sub WHERE sub.conversation_id = c.id;--> statement-breakpoint
UPDATE "conversations" c SET "last_read_seq" = sub.max_read_seq FROM (SELECT m.conversation_id, MAX(m."seq") AS max_read_seq FROM "messages" m JOIN "conversations" c2 ON c2.id = m.conversation_id WHERE c2.last_read_at IS NOT NULL AND m.created_at <= c2.last_read_at GROUP BY m.conversation_id) sub WHERE sub.conversation_id = c.id AND c.last_read_at IS NOT NULL;
