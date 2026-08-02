-- drizzle-migration-linter: allow-breaking
-- drizzle-migration-linter: reason=canary duplicates are deduplicated in this migration before the unique index is added; the table has at most a handful of rows, and the guard now inserts with ON CONFLICT DO NOTHING.
CREATE TABLE "content_encryption_state" (
	"id" text PRIMARY KEY NOT NULL,
	"key_fingerprint" text NOT NULL,
	"interactions_cursor_created_at" text,
	"interactions_cursor_id" uuid,
	"messages_cursor_id" uuid,
	"completed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "encryption_key_canaries" ADD COLUMN "purpose" text DEFAULT 'secrets' NOT NULL;--> statement-breakpoint
CREATE INDEX "conversations_last_message_at_idx" ON "conversations" USING btree ("last_message_at");--> statement-breakpoint
-- The guard's historical get()+create() had no uniqueness, so concurrent first
-- boots could leave duplicate canary rows. Deterministically keep the earliest
-- (created_at, then id) before adding the per-purpose singleton constraint;
-- every duplicate was written by the same boot key, so any survivor is valid.
DELETE FROM "encryption_key_canaries" a
USING "encryption_key_canaries" b
WHERE a.purpose = b.purpose
  AND (a.created_at, a.id) > (b.created_at, b.id);--> statement-breakpoint
CREATE UNIQUE INDEX "encryption_key_canaries_purpose_idx" ON "encryption_key_canaries" USING btree ("purpose");