-- drizzle-migration-linter: allow-breaking
-- drizzle-migration-linter: reason=The foreign key and index target a table created empty in this migration, so validation scans no existing rows and CONCURRENTLY is unnecessary. ON DELETE CASCADE intentionally removes delivery records when their run is deleted. The new table is additive and ignored by older releases.
CREATE TABLE "agent_run_attention_notices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" uuid NOT NULL,
	"channel_id" text NOT NULL,
	"workspace_id" text,
	"resolved" boolean DEFAULT false NOT NULL,
	"message_ts" text,
	"post_attempted" boolean DEFAULT false NOT NULL,
	"resolved_notified" boolean DEFAULT false NOT NULL,
	"claim_id" uuid,
	"claimed_at" timestamp
);
--> statement-breakpoint
ALTER TABLE "agent_run_attention_notices" ADD CONSTRAINT "agent_run_attention_notices_task_id_agent_runs_task_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."agent_runs"("task_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_run_attention_notices_task_id_idx" ON "agent_run_attention_notices" USING btree ("task_id");