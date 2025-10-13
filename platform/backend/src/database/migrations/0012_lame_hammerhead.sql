CREATE TABLE "dual_llm_results" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"tool_call_id" text NOT NULL,
	"conversations" jsonb NOT NULL,
	"result" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "dual_llm_results" ADD CONSTRAINT "dual_llm_results_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "dual_llm_results_agent_id_idx" ON "dual_llm_results" USING btree ("agent_id");