CREATE TABLE "mcp_tool_executions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tool_call_id" text NOT NULL,
	"agent_id" uuid,
	"conversation_id" uuid,
	"user_id" text,
	"tool_name" varchar(255) NOT NULL,
	"status" text DEFAULT 'executing' NOT NULL,
	"tool_call" jsonb,
	"tool_result" jsonb,
	"error" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "mcp_tool_executions" ADD CONSTRAINT "mcp_tool_executions_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_tool_executions" ADD CONSTRAINT "mcp_tool_executions_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_tool_executions" ADD CONSTRAINT "mcp_tool_executions_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_tool_executions_tool_call_id_uidx" ON "mcp_tool_executions" USING btree ("tool_call_id");--> statement-breakpoint
CREATE INDEX "mcp_tool_executions_agent_id_idx" ON "mcp_tool_executions" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "mcp_tool_executions_conversation_id_idx" ON "mcp_tool_executions" USING btree ("conversation_id");--> statement-breakpoint
CREATE INDEX "mcp_tool_executions_status_updated_at_idx" ON "mcp_tool_executions" USING btree ("status","updated_at");