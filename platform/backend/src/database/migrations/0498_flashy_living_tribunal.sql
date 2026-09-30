-- drizzle-migration-linter: allow-breaking
-- drizzle-migration-linter: reason=Foreign keys are added to agent_chatops_bots, a table created by this same migration, so there are no existing rows to validate or older writers to break.
CREATE TABLE "agent_chatops_bots" (
	"agent_id" uuid NOT NULL,
	"bot_id" uuid NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "agent_chatops_bots_agent_id_bot_id_pk" PRIMARY KEY("agent_id","bot_id")
);
--> statement-breakpoint
ALTER TABLE "agent_chatops_bots" ADD CONSTRAINT "agent_chatops_bots_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_chatops_bots" ADD CONSTRAINT "agent_chatops_bots_bot_id_chatops_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."chatops_bots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_chatops_bots_bot_id_idx" ON "agent_chatops_bots" USING btree ("bot_id");--> statement-breakpoint
-- Data migration: every agent that already holds channels or direct messages
-- under a bot gets a card for that bot, so nothing already assigned changes.
INSERT INTO "agent_chatops_bots" ("agent_id", "bot_id")
SELECT DISTINCT "agent_id", "bot_id"
FROM "chatops_channel_binding"
WHERE "agent_id" IS NOT NULL
ON CONFLICT DO NOTHING;
