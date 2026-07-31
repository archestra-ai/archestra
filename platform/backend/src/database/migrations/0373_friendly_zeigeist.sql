-- drizzle-migration-linter: reason=Brand-new empty table created in this same migration; the FK is added NOT VALID to satisfy the validation-lock rule, and validates trivially since no rows can pre-exist. Indexes are created on the empty table before any writes reach it.
CREATE TABLE "mcp_gateway_tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"principal" text NOT NULL,
	"tool_name" varchar(512) NOT NULL,
	"status" varchar(32) DEFAULT 'working' NOT NULL,
	"result" jsonb,
	"error" jsonb,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "mcp_gateway_tasks" ADD CONSTRAINT "mcp_gateway_tasks_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action NOT VALID;--> statement-breakpoint
CREATE INDEX "mcp_gateway_tasks_agent_principal_idx" ON "mcp_gateway_tasks" USING btree ("agent_id","principal");--> statement-breakpoint
CREATE INDEX "mcp_gateway_tasks_expires_at_idx" ON "mcp_gateway_tasks" USING btree ("expires_at");