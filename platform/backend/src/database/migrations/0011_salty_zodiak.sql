CREATE TABLE "dual_llm_config" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"main_agent_prompt" text NOT NULL,
	"quarantined_agent_prompt" text NOT NULL,
	"summary_prompt" text NOT NULL,
	"max_rounds" integer DEFAULT 5 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
