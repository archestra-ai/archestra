CREATE TABLE "schedule_trigger_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"trigger_id" uuid NOT NULL,
	"run_kind" text NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"initiated_by_user_id" text,
	"chat_conversation_id" uuid,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "schedule_triggers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"agent_id" uuid NOT NULL,
	"message_template" text NOT NULL,
	"cron_expression" text NOT NULL,
	"timezone" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"actor_user_id" text NOT NULL,
	"last_executed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "schedule_trigger_runs" ADD CONSTRAINT "schedule_trigger_runs_trigger_id_schedule_triggers_id_fk" FOREIGN KEY ("trigger_id") REFERENCES "public"."schedule_triggers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_triggers" ADD CONSTRAINT "schedule_triggers_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_triggers" ADD CONSTRAINT "schedule_triggers_actor_user_id_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "schedule_trigger_runs_trigger_id_idx" ON "schedule_trigger_runs" USING btree ("trigger_id");--> statement-breakpoint
CREATE INDEX "schedule_triggers_agent_id_idx" ON "schedule_triggers" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "schedule_triggers_actor_user_id_idx" ON "schedule_triggers" USING btree ("actor_user_id");--> statement-breakpoint
CREATE INDEX "schedule_triggers_enabled_last_executed_at_idx" ON "schedule_triggers" USING btree ("enabled","last_executed_at");