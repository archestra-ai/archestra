ALTER TABLE "mcp_tool_calls" ADD COLUMN "session_id" varchar;--> statement-breakpoint
ALTER TABLE "mcp_tool_calls" ADD COLUMN "llm_tool_call_id" varchar;--> statement-breakpoint
CREATE INDEX "mcp_tool_calls_session_created_at_idx" ON "mcp_tool_calls" USING btree ("session_id","created_at","id") WHERE "mcp_tool_calls"."session_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "mcp_tool_calls_run_id_idx" ON "mcp_tool_calls" USING btree ("run_id") WHERE "mcp_tool_calls"."run_id" IS NOT NULL;