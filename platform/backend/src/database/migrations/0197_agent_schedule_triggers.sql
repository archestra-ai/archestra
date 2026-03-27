ALTER TABLE "agents" ADD COLUMN "schedule_expression" text;
ALTER TABLE "agents" ADD COLUMN "schedule_enabled" boolean DEFAULT false NOT NULL;
ALTER TABLE "agents" ADD COLUMN "last_scheduled_run_at" timestamp with time zone;
ALTER TABLE "agents" ADD COLUMN "scheduled_message" text;
