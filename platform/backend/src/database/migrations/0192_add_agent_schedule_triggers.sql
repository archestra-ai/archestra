CREATE TABLE IF NOT EXISTS "agent_schedule_triggers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"trigger_type" text DEFAULT 'cron' NOT NULL,
	"cron_expression" text,
	"interval_seconds" integer,
	"execute_at" timestamp,
	"timezone" text DEFAULT 'UTC' NOT NULL,
	"input_message" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"misfire_grace_seconds" integer DEFAULT 60 NOT NULL,
	"last_executed_at" timestamp,
	"next_execute_at" timestamp,
	"last_status" text,
	"last_error" text,
	"execution_count" integer DEFAULT 0 NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_schedule_triggers_agent_id_idx" ON "agent_schedule_triggers" ("agent_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_schedule_triggers_organization_id_idx" ON "agent_schedule_triggers" ("organization_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_schedule_triggers_enabled_next_execute_at_idx" ON "agent_schedule_triggers" ("enabled","next_execute_at");--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agent_schedule_triggers" ADD CONSTRAINT "agent_schedule_triggers_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agent_schedule_triggers" ADD CONSTRAINT "agent_schedule_triggers_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
