ALTER TABLE "messages" ADD COLUMN "feedback" text;--> statement-breakpoint
-- NOT VALID keeps the add rolling-safe (no full-table validation); the column
-- is new so every existing row is NULL and nothing violates it, and the
-- constraint still enforces the domain on all future writes.
ALTER TABLE "messages" ADD CONSTRAINT "messages_feedback_check" CHECK ("messages"."feedback" in ('up', 'down')) NOT VALID;
