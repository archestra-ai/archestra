ALTER TABLE "interactions" RENAME COLUMN "agent_id" TO "profile_id";--> statement-breakpoint
ALTER TABLE "interactions" DROP CONSTRAINT "interactions_agent_id_agents_id_fk";
--> statement-breakpoint
DROP INDEX "interactions_agent_id_idx";--> statement-breakpoint
ALTER TABLE "interactions" ADD COLUMN "external_agent_id" varchar;--> statement-breakpoint
ALTER TABLE "interactions" ADD CONSTRAINT "interactions_profile_id_agents_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "interactions_external_agent_id_idx" ON "interactions" USING btree ("external_agent_id");--> statement-breakpoint
CREATE INDEX "interactions_agent_id_idx" ON "interactions" USING btree ("profile_id");