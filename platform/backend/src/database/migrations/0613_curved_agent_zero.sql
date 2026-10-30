ALTER TABLE "agent_runs" ADD COLUMN "runtime_limits" jsonb;--> statement-breakpoint
ALTER TABLE "organization" ADD COLUMN "agent_runtime_tiers" jsonb;