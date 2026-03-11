ALTER TABLE "knowledge_base_connectors" ADD COLUMN "visibility" text DEFAULT 'org-wide' NOT NULL;--> statement-breakpoint
ALTER TABLE "knowledge_base_connectors" ADD COLUMN "team_ids" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint

-- Migrate visibility/teamIds from knowledge bases to their connectors
UPDATE knowledge_base_connectors c
SET visibility = kb.visibility,
    team_ids = kb.team_ids
FROM knowledge_base_connector_assignment a
JOIN knowledge_bases kb ON kb.id = a.knowledge_base_id
WHERE a.connector_id = c.id;--> statement-breakpoint

ALTER TABLE "knowledge_bases" DROP COLUMN "visibility";--> statement-breakpoint
ALTER TABLE "knowledge_bases" DROP COLUMN "team_ids";
