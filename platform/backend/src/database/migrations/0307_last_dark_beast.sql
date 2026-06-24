ALTER TABLE "interactions" ADD COLUMN IF NOT EXISTS "thread_id" varchar;--> statement-breakpoint
ALTER TABLE "interactions" ADD COLUMN IF NOT EXISTS "parent_id" uuid;--> statement-breakpoint
ALTER TABLE "interactions" ADD COLUMN IF NOT EXISTS "request_shared_prefix" integer;--> statement-breakpoint
ALTER TABLE "interactions" ADD COLUMN IF NOT EXISTS "processed_request_shared_prefix" integer;--> statement-breakpoint
ALTER TABLE "interactions" ADD COLUMN IF NOT EXISTS "request_last_message_idx" integer;--> statement-breakpoint

DO $$ BEGIN
 ALTER TABLE "interactions" ADD CONSTRAINT "interactions_parent_id_interactions_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."interactions"("id") ON DELETE RESTRICT ON UPDATE no action NOT VALID;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
ALTER TABLE "interactions" VALIDATE CONSTRAINT "interactions_parent_id_interactions_id_fk";--> statement-breakpoint

-- MIGHT WANT TO PRE-APPLY MANUALLY IN CASE THE TABLE IS SUFFICIENTLY LARGE
CREATE INDEX IF NOT EXISTS "interactions_session_thread_created_at_idx" ON "interactions" USING btree ("session_id","thread_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "interactions_parent_id_idx" ON "interactions" USING btree ("parent_id");
