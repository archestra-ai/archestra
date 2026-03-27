ALTER TABLE "agent_tools" ADD COLUMN "credential_resolution_mode" text DEFAULT 'static' NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_tools" ADD COLUMN "enterprise_managed_config" jsonb;--> statement-breakpoint
UPDATE "agent_tools"
SET "credential_resolution_mode" = 'dynamic'
WHERE "use_dynamic_team_credential" = true;
