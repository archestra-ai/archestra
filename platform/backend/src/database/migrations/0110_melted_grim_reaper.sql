ALTER TABLE "interactions" ADD COLUMN "session_id" varchar;--> statement-breakpoint
ALTER TABLE "interactions" ADD COLUMN "session_source" varchar;--> statement-breakpoint
CREATE INDEX "interactions_session_id_idx" ON "interactions" USING btree ("session_id");