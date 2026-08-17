ALTER TABLE "organization" ADD COLUMN "model_provider_overrides" jsonb;--> statement-breakpoint
ALTER TABLE "organization" ADD COLUMN "messaging_channel_overrides" jsonb;--> statement-breakpoint
ALTER TABLE "organization" ADD COLUMN "knowledge_connector_overrides" jsonb;