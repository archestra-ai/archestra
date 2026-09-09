-- SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
ALTER TABLE "knowledge_bases" ADD COLUMN "visibility" text DEFAULT 'org-wide' NOT NULL;--> statement-breakpoint
ALTER TABLE "knowledge_bases" ADD COLUMN "team_ids" jsonb DEFAULT '[]'::jsonb NOT NULL;
