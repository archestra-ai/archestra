ALTER TABLE "tools" DROP CONSTRAINT "tools_catalog_id_name_agent_id_unique";--> statement-breakpoint
ALTER TABLE "tools" ADD COLUMN "prompt_agent_id" uuid;--> statement-breakpoint
ALTER TABLE "tools" ADD CONSTRAINT "tools_prompt_agent_id_prompt_agents_id_fk" FOREIGN KEY ("prompt_agent_id") REFERENCES "public"."prompt_agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tools" ADD CONSTRAINT "tools_catalog_id_name_agent_id_prompt_agent_id_unique" UNIQUE("catalog_id","name","agent_id","prompt_agent_id");