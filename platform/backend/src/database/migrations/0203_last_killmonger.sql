ALTER TABLE "knowledge_base_connectors" ADD COLUMN "visibility" text DEFAULT 'org-wide' NOT NULL;--> statement-breakpoint
ALTER TABLE "knowledge_base_connectors" ADD COLUMN "team_ids" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "knowledge_bases" DROP COLUMN "visibility";--> statement-breakpoint
ALTER TABLE "knowledge_bases" DROP COLUMN "team_ids";--> statement-breakpoint

-- Data migration: rename the knowledge RBAC resource key from
-- "knowledgeBase" to "knowledgeSource", preserving any existing
-- "knowledgeSource" actions by unioning them into the final key.
--
-- Note: Uses text LIKE checks instead of jsonb ? operator for PGlite compatibility.
UPDATE "organization_role"
SET "permission" = (
  (
    "permission"::jsonb - 'knowledgeBase' - 'knowledgeSource'
  ) || jsonb_build_object(
    'knowledgeSource',
    (
      SELECT jsonb_agg(DISTINCT val)
      FROM (
        SELECT jsonb_array_elements_text(
          COALESCE("permission"::jsonb->'knowledgeSource', '[]'::jsonb)
        ) AS val
        UNION
        SELECT jsonb_array_elements_text(
          COALESCE("permission"::jsonb->'knowledgeBase', '[]'::jsonb)
        ) AS val
      ) combined
    )
  )
)::text
WHERE "permission"::text LIKE '%"knowledgeBase":%';--> statement-breakpoint
