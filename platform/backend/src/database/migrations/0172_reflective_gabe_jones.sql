CREATE TABLE "tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_type" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempt" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 5 NOT NULL,
	"scheduled_for" timestamp DEFAULT now() NOT NULL,
	"started_at" timestamp,
	"completed_at" timestamp,
	"last_error" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "connector_runs" ADD COLUMN "total_batches" integer DEFAULT 0;--> statement-breakpoint
ALTER TABLE "connector_runs" ADD COLUMN "completed_batches" integer DEFAULT 0;--> statement-breakpoint
CREATE INDEX "tasks_dequeue_idx" ON "tasks" USING btree ("task_type","status","scheduled_for");