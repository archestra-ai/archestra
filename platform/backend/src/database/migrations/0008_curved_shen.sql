ALTER TABLE "chats" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "chats" CASCADE;--> statement-breakpoint
DROP INDEX "interactions_chat_id_idx";--> statement-breakpoint
ALTER TABLE "interactions" ADD COLUMN "agent_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "interactions" ADD COLUMN "request" jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "interactions" ADD COLUMN "response" jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "interactions" ADD CONSTRAINT "interactions_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "interactions_agent_id_idx" ON "interactions" USING btree ("agent_id");--> statement-breakpoint
ALTER TABLE "interactions" DROP COLUMN "chat_id";--> statement-breakpoint
ALTER TABLE "interactions" DROP COLUMN "content";--> statement-breakpoint
ALTER TABLE "interactions" DROP COLUMN "trusted";--> statement-breakpoint
ALTER TABLE "interactions" DROP COLUMN "blocked";--> statement-breakpoint
ALTER TABLE "interactions" DROP COLUMN "reason";
