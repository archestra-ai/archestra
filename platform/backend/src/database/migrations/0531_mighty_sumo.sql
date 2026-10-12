-- drizzle-migration-linter: allow-breaking
-- drizzle-migration-linter: reason=The foreign key targets reviewer_user_id, added in this migration, so every existing row holds NULL and validation finds nothing to reject. a2a_task_approval_request holds only paused tasks, so the partial index builds over a few rows. Deleting a user intentionally drops the reviews that only that user could decide.
ALTER TABLE "a2a_task_approval_request" ADD COLUMN "openappa_offer_id" text;--> statement-breakpoint
ALTER TABLE "a2a_task_approval_request" ADD COLUMN "openappa_review_text" text;--> statement-breakpoint
ALTER TABLE "a2a_task_approval_request" ADD COLUMN "remedy_arguments" jsonb;--> statement-breakpoint
ALTER TABLE "a2a_task_approval_request" ADD COLUMN "reviewer_user_id" text;--> statement-breakpoint
ALTER TABLE "a2a_task_approval_request" ADD COLUMN "slack_channel_id" text;--> statement-breakpoint
ALTER TABLE "a2a_task_approval_request" ADD COLUMN "slack_thread_ts" text;--> statement-breakpoint
ALTER TABLE "a2a_task_approval_request" ADD COLUMN "expires_at" timestamp;--> statement-breakpoint
ALTER TABLE "a2a_task_approval_request" ADD COLUMN "ruling" text;--> statement-breakpoint
ALTER TABLE "a2a_task_approval_request" ADD COLUMN "decided_at" timestamp;--> statement-breakpoint
ALTER TABLE "a2a_task_approval_request" ADD CONSTRAINT "a2a_task_approval_request_reviewer_user_id_user_id_fk" FOREIGN KEY ("reviewer_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "a2a_task_approval_request_openappa_expiry_idx" ON "a2a_task_approval_request" USING btree ("expires_at") WHERE "a2a_task_approval_request"."openappa_offer_id" IS NOT NULL;