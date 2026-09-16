-- drizzle-migration-linter: allow-breaking
-- drizzle-migration-linter: reason=Remove retired tool-result compression settings and accounting columns.
-- The production migration wrapper retires the dependent statistics index
-- concurrently before this transaction. Fresh installs replay the historical
-- index on an empty table; DROP COLUMN removes that dependency automatically.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
ALTER TABLE "interactions" DROP COLUMN "toon_tokens_before";--> statement-breakpoint
ALTER TABLE "interactions" DROP COLUMN "toon_tokens_after";--> statement-breakpoint
ALTER TABLE "interactions" DROP COLUMN "toon_cost_savings";--> statement-breakpoint
ALTER TABLE "interactions" DROP COLUMN "toon_skip_reason";--> statement-breakpoint
ALTER TABLE "organization" DROP COLUMN "convert_tool_results_to_toon";--> statement-breakpoint
ALTER TABLE "organization" DROP COLUMN "compression_scope";--> statement-breakpoint
ALTER TABLE "team" DROP COLUMN "convert_tool_results_to_toon";