ALTER TABLE "tools" DROP CONSTRAINT "tools_name_unique";--> statement-breakpoint
ALTER TABLE "tools" ADD CONSTRAINT "tools_agent_id_name_unique" UNIQUE("agent_id","name");