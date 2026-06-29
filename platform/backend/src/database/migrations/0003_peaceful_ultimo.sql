ALTER TABLE "tool_invocation_policies" RENAME COLUMN "block_prompt" TO "reason";--> statement-breakpoint
ALTER TABLE "tool_invocation_policies" DROP COLUMN "description";