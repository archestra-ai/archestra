-- Add agent_id column as nullable first
ALTER TABLE "conversations" ADD COLUMN "agent_id" uuid;--> statement-breakpoint

/*
@ikonstantinov 27-01-2026:
  Commented out because we do not seed default agent anymore.
*/
-- -- Create default agent if it doesn't exist
-- INSERT INTO "agents" (id, name, is_demo, is_default, created_at, updated_at)
-- SELECT gen_random_uuid(), 'Default Agent', false, true, now(), now()
-- WHERE NOT EXISTS (
--   SELECT 1 FROM "agents" WHERE is_default = true
-- );--> statement-breakpoint

-- -- Backfill all existing conversations with the default agent
-- UPDATE "conversations"
-- SET "agent_id" = (SELECT id FROM "agents" WHERE is_default = true LIMIT 1)
-- WHERE "agent_id" IS NULL;--> statement-breakpoint

-- Make agent_id NOT NULL
ALTER TABLE "conversations" ALTER COLUMN "agent_id" SET NOT NULL;--> statement-breakpoint

-- Add foreign key constraint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;