DROP INDEX "agents_slug_idx";--> statement-breakpoint
DROP INDEX "agents_personal_gateway_per_member_idx";--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "deleted_at" timestamp;--> statement-breakpoint
CREATE UNIQUE INDEX "agents_slug_idx" ON "agents" USING btree ("slug") WHERE "agents"."slug" IS NOT NULL AND "agents"."deleted_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "agents_personal_gateway_per_member_idx" ON "agents" USING btree ("organization_id","author_id") WHERE "agents"."agent_type" = 'mcp_gateway' AND "agents"."is_personal_gateway" = true AND "agents"."deleted_at" IS NULL;