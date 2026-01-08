-- Migration: Remove incorrect block_always default policies from trusted_data_policies
-- The 0105 migration incorrectly converted tool_result_treatment to block_always,
-- which blocks tool results entirely. This prevents the agentic loop from continuing.
-- Deleting these policies restores the original behavior where results are untrusted
-- by default but not blocked.

DELETE FROM "trusted_data_policies"
WHERE "action" = 'block_always'
  AND ("conditions" = '[]'::jsonb OR "conditions"::text = '[]');
