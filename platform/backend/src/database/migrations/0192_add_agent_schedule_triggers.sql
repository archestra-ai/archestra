-- Migration: 0192_add_agent_schedule_triggers
-- Created: 2026-03-22

CREATE TABLE IF NOT EXISTS "agent_schedule_triggers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"name" text NOT NULL,
	"message_template" text NOT NULL,
	"schedule_kind" text DEFAULT 'cron' NOT NULL,
	"cron_expression" text,
	"interval_seconds" integer,
	"run_at" timestamp with time zone,
	"timezone" text DEFAULT 'UTC' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"actor_user_id" text NOT NULL,
	"next_due_at" timestamp with time zone,
	"last_run_at" timestamp with time zone,
	"last_run_status" text,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "agent_schedule_trigger_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"trigger_id" uuid NOT NULL,
	"organization_id" text NOT NULL,
	"run_kind" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"due_at" timestamp with time zone,
	"initiated_by_user_id" text,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"error" text,
	"agent_id_snapshot" text NOT NULL,
	"message_template_snapshot" text NOT NULL,
	"actor_user_id_snapshot" text NOT NULL,
	"cron_expression_snapshot" text,
	"timezone_snapshot" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "idx_agent_schedule_triggers_enabled_next_due_at" ON "agent_schedule_triggers" ("enabled", "next_due_at");
DO $$ BEGIN
 ALTER TABLE "agent_schedule_trigger_runs" ADD CONSTRAINT "agent_schedule_trigger_runs_trigger_id_agent_schedule_triggers_id_fk" FOREIGN KEY ("trigger_id") REFERENCES "agent_schedule_triggers"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

ALTER TABLE "agent_schedule_trigger_runs" ADD CONSTRAINT "uq_agent_trigger_id_due_at" UNIQUE("trigger_id", "due_at");
