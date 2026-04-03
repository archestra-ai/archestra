ALTER TABLE "knowledge_base_connectors" ADD COLUMN "visibility" text DEFAULT 'org-wide' NOT NULL;--> statement-breakpoint
ALTER TABLE "knowledge_base_connectors" ADD COLUMN "team_ids" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "knowledge_bases" DROP COLUMN "visibility";--> statement-breakpoint
ALTER TABLE "knowledge_bases" DROP COLUMN "team_ids";--> statement-breakpoint

-- Data migration: normalize legacy knowledge RBAC resource keys to "knowledgeBase".
-- This preserves any existing actions from "knowledgeBases", "knowledgeSources",
-- and "knowledgeBase" by unioning them into the current key.
--
-- Note: Uses text LIKE checks instead of jsonb ? operator for PGlite compatibility.
UPDATE "organization_role"
SET "permission" = (
  (
    "permission"::jsonb - 'knowledgeBases' - 'knowledgeSources' - 'knowledgeBase'
  ) || jsonb_build_object(
    'knowledgeBase',
    (
      SELECT jsonb_agg(DISTINCT val)
      FROM (
        SELECT jsonb_array_elements_text(
          COALESCE("permission"::jsonb->'knowledgeBase', '[]'::jsonb)
        ) AS val
        UNION
        SELECT jsonb_array_elements_text(
          COALESCE("permission"::jsonb->'knowledgeSources', '[]'::jsonb)
        ) AS val
        UNION
        SELECT jsonb_array_elements_text(
          COALESCE("permission"::jsonb->'knowledgeBases', '[]'::jsonb)
        ) AS val
      ) combined
    )
  )
)::text
WHERE "permission"::text LIKE '%"knowledgeBases":%'
   OR "permission"::text LIKE '%"knowledgeSources":%';--> statement-breakpoint
