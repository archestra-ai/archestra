DO $$ BEGIN
 CREATE TYPE "public"."optimization_rule_type" AS ENUM('content_length', 'tool_presence');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "optimization_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"rule_type" "optimization_rule_type" NOT NULL,
	"conditions" jsonb NOT NULL,
	"target_model" text NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "optimization_rules" ADD CONSTRAINT "optimization_rules_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
