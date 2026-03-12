ALTER TABLE "organization" ADD COLUMN "favicon" text;--> statement-breakpoint
ALTER TABLE "organization" ADD COLUMN "app_name" text;--> statement-breakpoint
ALTER TABLE "organization" ADD COLUMN "og_description" text;--> statement-breakpoint
ALTER TABLE "organization" ADD COLUMN "footer_text" text;--> statement-breakpoint
ALTER TABLE "organization" ADD COLUMN "chat_placeholders" text[];--> statement-breakpoint
ALTER TABLE "organization" ADD COLUMN "icon_logo" text;--> statement-breakpoint
ALTER TABLE "organization" ADD COLUMN "show_two_factor" boolean DEFAULT false NOT NULL;--> statement-breakpoint

-- Data migration: Rename "minimalisticView" → "simpleView" in custom role permissions JSONB
-- Note: Use jsonb_exists() instead of ? operator to avoid Drizzle's parameter placeholder conflict
UPDATE "organization_role"
SET "permission" = (
  "permission"::jsonb - 'minimalisticView'
  || jsonb_build_object('simpleView', COALESCE("permission"::jsonb -> 'minimalisticView', '[]'::jsonb))
)::text
WHERE jsonb_exists("permission"::jsonb, 'minimalisticView');--> statement-breakpoint

-- Data migration: Rename "appearanceSettings" → "organizationSettings" in custom role permissions JSONB
UPDATE "organization_role"
SET "permission" = (
  "permission"::jsonb - 'appearanceSettings'
  || jsonb_build_object('organizationSettings', COALESCE("permission"::jsonb -> 'appearanceSettings', '[]'::jsonb))
)::text
WHERE jsonb_exists("permission"::jsonb, 'appearanceSettings');--> statement-breakpoint

-- Data migration: Add "chatAgentPicker" and "chatProviderSettings" with ["enable"] to existing custom roles
-- Using ["enable"] preserves existing behavior where all users could see the agent picker and provider settings
UPDATE "organization_role"
SET "permission" = (
  "permission"::jsonb
  || '{"chatAgentPicker": ["enable"], "chatProviderSettings": ["enable"]}'::jsonb
)::text
WHERE NOT jsonb_exists("permission"::jsonb, 'chatAgentPicker');