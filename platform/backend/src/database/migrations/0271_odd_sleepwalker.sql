ALTER TABLE "organization" ADD COLUMN "analytics_instance_id" uuid DEFAULT gen_random_uuid() NOT NULL;--> statement-breakpoint
ALTER TABLE "organization" ADD COLUMN "analytics_instance_started_at" timestamp;--> statement-breakpoint
ALTER TABLE "organization" ADD COLUMN "analytics_instance_last_heartbeat_at" timestamp;