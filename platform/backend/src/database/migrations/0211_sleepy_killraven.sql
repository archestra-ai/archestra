ALTER TABLE "organization" ADD COLUMN "connection_default_mcp_gateway_id" uuid;--> statement-breakpoint
ALTER TABLE "organization" ADD COLUMN "connection_default_llm_proxy_id" uuid;--> statement-breakpoint
ALTER TABLE "organization" ADD COLUMN "connection_shown_client_ids" text[];--> statement-breakpoint
ALTER TABLE "organization" ADD COLUMN "connection_shown_providers" text[];--> statement-breakpoint

-- FK constraints: auto-clear org connection defaults when the agent is deleted
ALTER TABLE "organization"
  ADD CONSTRAINT "organization_connection_default_mcp_gateway_id_agents_id_fk"
  FOREIGN KEY ("connection_default_mcp_gateway_id") REFERENCES "agents"("id") ON DELETE SET NULL;--> statement-breakpoint

ALTER TABLE "organization"
  ADD CONSTRAINT "organization_connection_default_llm_proxy_id_agents_id_fk"
  FOREIGN KEY ("connection_default_llm_proxy_id") REFERENCES "agents"("id") ON DELETE SET NULL;