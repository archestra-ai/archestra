-- drizzle-migration-linter: allow-breaking
-- drizzle-migration-linter: reason=The column is new in this migration, so every existing row holds NULL and passes the check, and openappa_yells holds one row per yell report, so the scan is short.
ALTER TABLE "openappa_yells" ADD COLUMN "conversation_id" uuid;--> statement-breakpoint
ALTER TABLE "openappa_yells" ADD CONSTRAINT "openappa_yells_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "openappa_yells_conversation_id_idx" ON "openappa_yells" USING btree ("conversation_id");