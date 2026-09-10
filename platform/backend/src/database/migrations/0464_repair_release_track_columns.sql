-- SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
-- A stable-line backport advanced Drizzle's timestamp past the team-role and
-- knowledge-base access migrations on the beta line. Repair both skipped
-- changes without overwriting values on databases that already applied them.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE "team" ADD COLUMN IF NOT EXISTS "roles" text[] DEFAULT '{}' NOT NULL;
--> statement-breakpoint
ALTER TABLE "knowledge_bases" ADD COLUMN IF NOT EXISTS "visibility" text DEFAULT 'org-wide' NOT NULL;
--> statement-breakpoint
ALTER TABLE "knowledge_bases" ADD COLUMN IF NOT EXISTS "team_ids" jsonb DEFAULT '[]'::jsonb NOT NULL;
