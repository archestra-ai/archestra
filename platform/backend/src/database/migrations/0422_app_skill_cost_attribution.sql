ALTER TABLE "apps" ADD COLUMN "authoring_session_id" text;--> statement-breakpoint
ALTER TABLE "interactions" ADD COLUMN "app_id" uuid;--> statement-breakpoint
ALTER TABLE "skill_usage_events" ADD COLUMN "session_id" text;--> statement-breakpoint
ALTER TABLE "skill_usage_events" ADD COLUMN "context_tokens" integer;--> statement-breakpoint
CREATE INDEX "apps_authoring_session_id_idx" ON "apps" USING btree ("authoring_session_id");