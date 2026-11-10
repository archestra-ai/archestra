ALTER TABLE "routing_plans" ALTER COLUMN "budget_usd_per_day" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "auto_routing_budget_preset" text;