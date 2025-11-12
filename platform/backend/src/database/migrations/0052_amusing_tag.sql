CREATE TABLE "optimization_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"rule_type" text NOT NULL,
	"conditions" jsonb NOT NULL,
	"provider" text NOT NULL,
	"target_model" text NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "mcp_server" ALTER COLUMN "server_type" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "optimize_cost" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "interactions" ADD COLUMN "baseline_cost" numeric(13, 10);--> statement-breakpoint
ALTER TABLE "interactions" ADD COLUMN "cost" numeric(13, 10);--> statement-breakpoint
ALTER TABLE "optimization_rules" ADD CONSTRAINT "optimization_rules_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;