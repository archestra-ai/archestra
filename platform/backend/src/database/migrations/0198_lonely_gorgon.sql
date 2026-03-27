CREATE TYPE "public"."agent_schedule_trigger_type" AS ENUM('cron', 'interval', 'one_time');--> statement-breakpoint
CREATE TABLE "agent_schedule_triggers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"trigger_type" "agent_schedule_trigger_type" NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"cron_expression" text,
	"interval_seconds" integer,
	"scheduled_at" timestamp,
	"message" text DEFAULT '' NOT NULL,
	"last_executed_at" timestamp,
	"next_execution_at" timestamp,
	"execution_count" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"misfire_grace_seconds" integer DEFAULT 300 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_schedule_triggers" ADD CONSTRAINT "agent_schedule_triggers_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_schedule_triggers_agent_id_idx" ON "agent_schedule_triggers" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "agent_schedule_triggers_enabled_idx" ON "agent_schedule_triggers" USING btree ("enabled","next_execution_at") WHERE "agent_schedule_triggers"."enabled" = true;--> statement-breakpoint
CREATE INDEX "agent_schedule_triggers_org_idx" ON "agent_schedule_triggers" USING btree ("organization_id");