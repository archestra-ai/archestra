ALTER TABLE "mcp_tool_calls" ADD COLUMN "user_id" text;--> statement-breakpoint
ALTER TABLE "mcp_tool_calls" ADD COLUMN "auth_method" varchar(50);--> statement-breakpoint
ALTER TABLE "mcp_tool_calls" ADD CONSTRAINT "mcp_tool_calls_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;