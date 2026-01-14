ALTER TABLE "tools" ADD COLUMN "policies_auto_configured_at" timestamp;--> statement-breakpoint
ALTER TABLE "tools" ADD COLUMN "policies_auto_configuring_started_at" timestamp;--> statement-breakpoint
ALTER TABLE "tools" ADD COLUMN "policies_auto_configured_reasoning" text;--> statement-breakpoint
ALTER TABLE "agent_tools" DROP COLUMN "policies_auto_configured_at";--> statement-breakpoint
ALTER TABLE "agent_tools" DROP COLUMN "policies_auto_configuring_started_at";--> statement-breakpoint
ALTER TABLE "agent_tools" DROP COLUMN "policies_auto_configured_reasoning";