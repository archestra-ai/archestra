ALTER TABLE "organization" ADD COLUMN "collapse_sidebar_by_default" boolean DEFAULT false NOT NULL;--> statement-breakpoint
-- Simple View is no longer a role resource: whether the sidebar starts
-- collapsed is an Appearance setting, and each person's own toggle is
-- remembered in their browser. Custom roles drop the retired key.
UPDATE "organization_role"
SET "permission" = ("permission"::jsonb - 'simpleView')::text,
  "updated_at" = now()
WHERE "permission"::jsonb ? 'simpleView';
