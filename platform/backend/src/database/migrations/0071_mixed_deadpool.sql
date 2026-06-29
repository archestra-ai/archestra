ALTER TABLE "optimization_rules" DROP COLUMN "rule_type";--> statement-breakpoint

-- Migrate optimization_rules.conditions from object to array
-- This migration is idempotent: running it multiple times won't create nested arrays
UPDATE optimization_rules
SET conditions = jsonb_build_array(conditions)
WHERE jsonb_typeof(conditions) = 'object';
