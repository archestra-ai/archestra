-- Update existing tool invocation policy action values from 'allow' to 'allow_when_context_is_untrusted'
UPDATE "tool_invocation_policies" SET "action" = 'allow_when_context_is_untrusted' WHERE "action" = 'allow';--> statement-breakpoint

-- Update existing tool invocation policy action values from 'block' to 'block_always'
UPDATE "tool_invocation_policies" SET "action" = 'block_always' WHERE "action" = 'block';
