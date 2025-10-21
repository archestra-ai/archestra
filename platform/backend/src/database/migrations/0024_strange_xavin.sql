ALTER TABLE "tool_invocation_policies" RENAME COLUMN "tool_id" TO "agent_tool_id";--> statement-breakpoint
ALTER TABLE "trusted_data_policies" RENAME COLUMN "tool_id" TO "agent_tool_id";--> statement-breakpoint
ALTER TABLE "tool_invocation_policies" DROP CONSTRAINT "tool_invocation_policies_tool_id_tools_id_fk";
--> statement-breakpoint
ALTER TABLE "trusted_data_policies" DROP CONSTRAINT "trusted_data_policies_tool_id_tools_id_fk";
--> statement-breakpoint
ALTER TABLE "agent_tools" ADD COLUMN "allow_usage_when_untrusted_data_is_present" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_tools" ADD COLUMN "tool_result_treatment" text DEFAULT 'untrusted' NOT NULL;--> statement-breakpoint
ALTER TABLE "tool_invocation_policies" ADD CONSTRAINT "tool_invocation_policies_agent_tool_id_agent_tools_id_fk" FOREIGN KEY ("agent_tool_id") REFERENCES "public"."agent_tools"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trusted_data_policies" ADD CONSTRAINT "trusted_data_policies_agent_tool_id_agent_tools_id_fk" FOREIGN KEY ("agent_tool_id") REFERENCES "public"."agent_tools"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tools" DROP COLUMN "source";--> statement-breakpoint
ALTER TABLE "tools" DROP COLUMN "allow_usage_when_untrusted_data_is_present";--> statement-breakpoint
ALTER TABLE "tools" DROP COLUMN "tool_result_treatment";