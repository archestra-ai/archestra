CREATE TYPE "public"."llm_provider" AS ENUM('anthropic', 'openai');--> statement-breakpoint
CREATE TYPE "public"."optimization_rule_type" AS ENUM('content_length', 'tool_presence');--> statement-breakpoint
CREATE TABLE "optimization_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"rule_type" "optimization_rule_type" NOT NULL,
	"conditions" jsonb NOT NULL,
	"provider" "llm_provider" NOT NULL,
	"target_model" text NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "optimize_cost" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "interactions" ADD COLUMN "baseline_cost" numeric(15, 10);--> statement-breakpoint
ALTER TABLE "interactions" ADD COLUMN "cost" numeric(15, 10);--> statement-breakpoint
ALTER TABLE "optimization_rules" ADD CONSTRAINT "optimization_rules_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;
