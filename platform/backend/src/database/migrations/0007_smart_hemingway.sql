ALTER TABLE "agent_tool_invocation_policies" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "agent_trusted_data_policies" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "agent_tool_invocation_policies" CASCADE;--> statement-breakpoint
DROP TABLE "agent_trusted_data_policies" CASCADE;--> statement-breakpoint
ALTER TABLE "trusted_data_policies" ALTER COLUMN "action" SET DEFAULT 'mark_as_trusted';