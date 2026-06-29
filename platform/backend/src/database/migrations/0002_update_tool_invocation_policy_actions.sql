-- Update existing tool invocation policy action values
UPDATE "tool_invocation_policies"
SET "action" = 'allow_when_context_is_untrusted'
WHERE "action" = 'allow';

UPDATE "tool_invocation_policies"
SET "action" = 'block_always'
WHERE "action" = 'block';
