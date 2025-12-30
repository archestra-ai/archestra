CREATE TABLE "prompt_agents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"prompt_id" uuid NOT NULL,
	"agent_prompt_id" uuid NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "prompt_agents" ADD CONSTRAINT "prompt_agents_prompt_id_prompts_id_fk" FOREIGN KEY ("prompt_id") REFERENCES "public"."prompts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prompt_agents" ADD CONSTRAINT "prompt_agents_agent_prompt_id_prompts_id_fk" FOREIGN KEY ("agent_prompt_id") REFERENCES "public"."prompts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "prompt_agent_unique" ON "prompt_agents" USING btree ("prompt_id","agent_prompt_id");