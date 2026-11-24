-- drizzle-migration-linter: allow-breaking
-- drizzle-migration-linter: reason=The only foreign key is on a2a_task_release_receipts, which this migration creates empty, so the add-validating-constraint rule scans no existing rows; attaching it briefly locks a2a_task. Deleting a task deletes its receipts on purpose: a receipt describes its task's content and means nothing without it. The guardrails_deployment columns are nullable with no default, so adding them rewrites nothing; no existing row is read or changed.
CREATE TABLE "a2a_task_release_receipts" (
	"task_id" uuid NOT NULL,
	"session" text NOT NULL,
	"fact_position" bigint NOT NULL,
	"digest" varchar(64) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "a2a_task_release_receipts_task_id_session_fact_position_pk" PRIMARY KEY("task_id","session","fact_position")
);
--> statement-breakpoint
CREATE TABLE "chatops_delivery_receipts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" varchar(32) NOT NULL,
	"workspace_id" varchar(256),
	"channel_id" varchar(256) NOT NULL,
	"message_id" varchar(512) NOT NULL,
	"content_digest" varchar(64) NOT NULL,
	"receipts" jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "chatops_delivery_receipts_message_key_uq" UNIQUE NULLS NOT DISTINCT("provider","workspace_id","channel_id","message_id")
);
--> statement-breakpoint
ALTER TABLE "guardrails_deployment" ADD COLUMN "mode" varchar(16);--> statement-breakpoint
ALTER TABLE "guardrails_deployment" ADD COLUMN "person_approval" varchar(16);--> statement-breakpoint
ALTER TABLE "guardrails_deployment" ADD COLUMN "enforced_marks" text[];--> statement-breakpoint
ALTER TABLE "a2a_task_release_receipts" ADD CONSTRAINT "a2a_task_release_receipts_task_id_a2a_task_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."a2a_task"("id") ON DELETE cascade ON UPDATE no action;