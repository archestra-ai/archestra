-- STEP 1: Add new columns FIRST (before any data migration)
ALTER TABLE "chat_api_keys" ADD COLUMN "scope" text DEFAULT 'personal' NOT NULL;--> statement-breakpoint
ALTER TABLE "chat_api_keys" ADD COLUMN "user_id" text;--> statement-breakpoint
ALTER TABLE "chat_api_keys" ADD COLUMN "team_id" text;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "chat_api_key_id" uuid;--> statement-breakpoint

-- STEP 2: DATA MIGRATION - Convert existing keys to scopes
-- 2a: Keys with is_organization_default=true → scope='org_wide'
UPDATE chat_api_keys
SET scope = 'org_wide'
WHERE is_organization_default = true;--> statement-breakpoint

-- 2b: For keys with profile assignments, create team-scoped copies
-- Join: chat_api_keys → profile_chat_api_keys → agents → agent_team → team
INSERT INTO chat_api_keys (organization_id, name, provider, secret_id, scope, team_id, created_at, updated_at)
SELECT DISTINCT
  cak.organization_id,
  cak.name || ' (Team: ' || t.name || ')',
  cak.provider,
  cak.secret_id,
  'team',
  at.team_id,
  NOW(),
  NOW()
FROM chat_api_keys cak
JOIN profile_chat_api_keys pcak ON cak.id = pcak.chat_api_key_id
JOIN agents a ON pcak.agent_id = a.id
JOIN agent_team at ON a.id = at.agent_id
JOIN team t ON at.team_id = t.id
WHERE cak.is_organization_default = false
  AND cak.scope = 'personal';--> statement-breakpoint

-- STEP 3: Now safe to drop old table and column
ALTER TABLE "profile_chat_api_keys" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "profile_chat_api_keys" CASCADE;--> statement-breakpoint
DROP INDEX "chat_api_keys_org_provider_default_unique";--> statement-breakpoint

-- STEP 4: Add FK constraints after columns exist
ALTER TABLE "chat_api_keys" ADD CONSTRAINT "chat_api_keys_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_api_keys" ADD CONSTRAINT "chat_api_keys_team_id_team_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."team"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_chat_api_key_id_chat_api_keys_id_fk" FOREIGN KEY ("chat_api_key_id") REFERENCES "public"."chat_api_keys"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint

-- STEP 5: Add unique indexes for scope constraints
CREATE UNIQUE INDEX "chat_api_keys_personal_unique" ON "chat_api_keys" USING btree ("user_id","provider") WHERE "chat_api_keys"."scope" = 'personal' AND "chat_api_keys"."user_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "chat_api_keys_team_unique" ON "chat_api_keys" USING btree ("team_id","provider") WHERE "chat_api_keys"."scope" = 'team' AND "chat_api_keys"."team_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "chat_api_keys_org_wide_unique" ON "chat_api_keys" USING btree ("organization_id","provider") WHERE "chat_api_keys"."scope" = 'org_wide';--> statement-breakpoint

-- STEP 6: Drop old column last
ALTER TABLE "chat_api_keys" DROP COLUMN "is_organization_default";
