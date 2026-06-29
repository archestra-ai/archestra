ALTER TABLE "agent_tools" ADD COLUMN "policies_auto_configured_at" timestamp;--> statement-breakpoint
ALTER TABLE "agent_tools" ADD COLUMN "policies_auto_configuring_started_at" timestamp;--> statement-breakpoint
ALTER TABLE "agent_tools" ADD COLUMN "policies_auto_configured_reasoning" text;--> statement-breakpoint
ALTER TABLE "organization" ADD COLUMN "auto_configure_new_tools" boolean DEFAULT false NOT NULL;