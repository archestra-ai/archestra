-- Monotonic insertion-order column for messages. The obvious one-liner
-- (ADD COLUMN ... DEFAULT nextval(...)) fills existing rows in physical row
-- order (volatile default => full-table rewrite), which can disagree with
-- created_at for historical rows. Instead: add the bare column, backfill in
-- (created_at, id) order, then attach the default for new writes. Old
-- writers keep inserting during rollout (default fires server-side);
-- NOT NULL lands in a later contract-phase migration per the migration
-- linter's expand/contract rule.
CREATE SEQUENCE "messages_seq_seq";--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "seq" bigint;--> statement-breakpoint
UPDATE "messages" m SET "seq" = sub.rn FROM (SELECT id, row_number() OVER (ORDER BY created_at, id) AS rn FROM "messages") sub WHERE m.id = sub.id;--> statement-breakpoint
SELECT setval('"messages_seq_seq"', COALESCE((SELECT MAX("seq") FROM "messages"), 0) + 1, false);--> statement-breakpoint
ALTER TABLE "messages" ALTER COLUMN "seq" SET DEFAULT nextval('messages_seq_seq');--> statement-breakpoint
ALTER SEQUENCE "messages_seq_seq" OWNED BY "messages"."seq";--> statement-breakpoint
CREATE INDEX "messages_conversation_id_seq_idx" ON "messages" USING btree ("conversation_id","seq");
