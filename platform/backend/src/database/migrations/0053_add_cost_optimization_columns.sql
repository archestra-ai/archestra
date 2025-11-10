ALTER TABLE "agents" ADD COLUMN "optimize_cost" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "interactions" ADD COLUMN "baseline_cost" numeric(15, 10);--> statement-breakpoint
ALTER TABLE "interactions" ADD COLUMN "cost" numeric(15, 10);
