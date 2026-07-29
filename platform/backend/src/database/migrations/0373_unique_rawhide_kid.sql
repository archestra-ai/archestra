-- drizzle-migration-linter: allow-breaking
-- drizzle-migration-linter: reason=the flagged FK/unique constraints target a2a_artifact and a2a_task_event, both created empty in this same migration, so validation scans nothing; the one FK on the pre-existing a2a_task (agent_id) validates a column added NULL-only in this migration, so there are zero non-null rows to check; a2a_task is a small table (rows exist only for tool-approval interrupts), so its non-concurrent index builds and the bounded backfill UPDATE at the bottom hold their locks only briefly
CREATE TABLE "a2a_artifact" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"parts" jsonb NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "a2a_task_event" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "a2a_task" ADD COLUMN "agent_id" uuid;--> statement-breakpoint
ALTER TABLE "a2a_task" ADD COLUMN "status_reason" text;--> statement-breakpoint
ALTER TABLE "a2a_task" ADD COLUMN "state_changed_at" timestamp;--> statement-breakpoint
ALTER TABLE "a2a_task" ADD COLUMN "last_heartbeat_at" timestamp;--> statement-breakpoint
ALTER TABLE "a2a_task" ADD COLUMN "next_event_seq" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "a2a_artifact" ADD CONSTRAINT "a2a_artifact_task_id_a2a_task_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."a2a_task"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "a2a_task_event" ADD CONSTRAINT "a2a_task_event_task_id_a2a_task_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."a2a_task"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "a2a_artifact_task_id_idx" ON "a2a_artifact" USING btree ("task_id");--> statement-breakpoint
CREATE UNIQUE INDEX "a2a_task_event_task_id_seq_idx" ON "a2a_task_event" USING btree ("task_id","seq");--> statement-breakpoint
CREATE INDEX "a2a_task_event_created_at_idx" ON "a2a_task_event" USING btree ("created_at");--> statement-breakpoint
ALTER TABLE "a2a_task" ADD CONSTRAINT "a2a_task_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "a2a_task_agent_state_changed_idx" ON "a2a_task" USING btree ("agent_id","state_changed_at","id");--> statement-breakpoint
CREATE INDEX "a2a_task_active_heartbeat_idx" ON "a2a_task" USING btree ("last_heartbeat_at") WHERE "a2a_task"."state" IN ('TASK_STATE_SUBMITTED', 'TASK_STATE_WORKING');--> statement-breakpoint
-- Backfill: every code path that writes tasks from this release on also sets
-- state_changed_at (protocol TaskStatus.timestamp + the ListTasks ordering /
-- cursor key), so pre-existing rows get their best approximation and
-- ordering needs no COALESCE. Reapability is opt-in via last_heartbeat_at:
-- it is backfilled ONLY for active-state rows that have been quiet for over
-- an hour — the immortal WORKING rows older releases could strand — never
-- for recently-updated rows, which may be live approval runs mid-deploy.
-- a2a_task is small (rows exist only for approval interrupts), so these
-- unbounded UPDATEs hold their locks only briefly.
UPDATE "a2a_task" SET "state_changed_at" = "updated_at" WHERE "state_changed_at" IS NULL;--> statement-breakpoint
UPDATE "a2a_task" SET "last_heartbeat_at" = "updated_at" WHERE "last_heartbeat_at" IS NULL AND "state" IN ('TASK_STATE_SUBMITTED', 'TASK_STATE_WORKING') AND "updated_at" < now() - interval '1 hour';