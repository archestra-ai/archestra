ALTER TABLE "agents" ADD COLUMN "sso_provider_id" text;--> statement-breakpoint
ALTER TABLE "mcp_tool_calls" ADD COLUMN "external_identity" jsonb;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_sso_provider_id_sso_provider_id_fk" FOREIGN KEY ("sso_provider_id") REFERENCES "public"."sso_provider"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agents_sso_provider_id_idx" ON "agents" USING btree ("sso_provider_id");