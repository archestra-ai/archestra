ALTER TABLE "mcp_gateway_tasks" ADD COLUMN "conversation_id" uuid;--> statement-breakpoint
ALTER TABLE "mcp_gateway_tasks" ADD COLUMN "context" jsonb;--> statement-breakpoint
ALTER TABLE "mcp_gateway_tasks" ADD CONSTRAINT "mcp_gateway_tasks_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action NOT VALID;--> statement-breakpoint
CREATE INDEX "mcp_gateway_tasks_conversation_id_idx" ON "mcp_gateway_tasks" USING btree ("conversation_id");