ALTER TABLE "agents" ADD COLUMN "deleted_at" timestamp;
ALTER TABLE "conversations" ADD COLUMN "deleted_at" timestamp;
ALTER TABLE "knowledge_bases" ADD COLUMN "deleted_at" timestamp;
ALTER TABLE "limits" ADD COLUMN "deleted_at" timestamp;
ALTER TABLE "mcp_server" ADD COLUMN "deleted_at" timestamp;
ALTER TABLE "optimization_rules" ADD COLUMN "deleted_at" timestamp;
ALTER TABLE "schedule_triggers" ADD COLUMN "deleted_at" timestamp;
ALTER TABLE "secret" ADD COLUMN "deleted_at" timestamp;
ALTER TABLE "team" ADD COLUMN "deleted_at" timestamp;
ALTER TABLE "tool_invocation_policies" ADD COLUMN "deleted_at" timestamp;
ALTER TABLE "trusted_data_policies" ADD COLUMN "deleted_at" timestamp;
DROP INDEX "agents_slug_idx";--> statement-breakpoint
DROP INDEX "agents_personal_gateway_per_member_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "agents_slug_idx" ON "agents" USING btree ("slug") WHERE "agents"."slug" IS NOT NULL AND "agents"."deleted_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "agents_personal_gateway_per_member_idx" ON "agents" USING btree ("organization_id","author_id") WHERE "agents"."agent_type" = 'mcp_gateway' AND "agents"."is_personal_gateway" = true AND "agents"."deleted_at" IS NULL;
