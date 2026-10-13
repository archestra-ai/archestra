ALTER TABLE "mcp_tool_calls" ADD COLUMN "oauth_client_id" text;--> statement-breakpoint
ALTER TABLE "mcp_tool_calls" ADD COLUMN "source" varchar(20);--> statement-breakpoint
ALTER TABLE "skill_marketplace_credential" ADD COLUMN "connection_setup_id" uuid;--> statement-breakpoint
ALTER TABLE "skill_marketplace_credential" ADD CONSTRAINT "skill_marketplace_credential_connection_setup_id_connection_setups_id_fk" FOREIGN KEY ("connection_setup_id") REFERENCES "public"."connection_setups"("id") ON DELETE set null ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "skill_marketplace_credential" VALIDATE CONSTRAINT "skill_marketplace_credential_connection_setup_id_connection_setups_id_fk";