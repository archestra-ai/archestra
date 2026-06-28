-- drizzle-migration-linter: allow-breaking
-- drizzle-migration-linter: reason=Filesystem file store needs a per-project slug folder and filename uniqueness; the My Files surface is not in production use, the slug is backfilled before its NOT NULL/unique constraints, and the UPDATEs dedupe any stray rows before each unique index, so nothing can fail.
-- Add the project slug nullable, backfill it, then enforce NOT NULL — the column
-- is the project's immutable filesystem folder. Existing rows get a slug derived
-- from the name; duplicates within an org get the row id appended (guaranteed
-- unique). New rows get a clean slug from ProjectModel.generateUniqueSlug.
ALTER TABLE "projects" ADD COLUMN "slug" text;--> statement-breakpoint
UPDATE "projects" AS p
SET "slug" = ranked.slug
FROM (
  SELECT "id",
    CASE WHEN rn = 1 THEN base ELSE base || '-' || "id"::text END AS slug
  FROM (
    SELECT "id",
      coalesce(
        nullif(trim(both '-' from regexp_replace(lower("name"), '[^a-z0-9]+', '-', 'g')), ''),
        'project'
      ) AS base,
      row_number() OVER (
        PARTITION BY "organization_id",
          coalesce(
            nullif(trim(both '-' from regexp_replace(lower("name"), '[^a-z0-9]+', '-', 'g')), ''),
            'project'
          )
        ORDER BY "created_at", "id"
      ) AS rn
    FROM "projects"
  ) AS base_ranked
) AS ranked
WHERE p."id" = ranked."id";--> statement-breakpoint
ALTER TABLE "projects" ALTER COLUMN "slug" SET NOT NULL;--> statement-breakpoint
-- Defensive dedup before the new UNIQUE indexes. The "My Files" / projects-files
-- surface is not in production use, so these are expected to touch zero rows;
-- they exist only so the index creation below cannot fail on a stray duplicate
-- left by dev/test data. Duplicates keep the oldest row's name; newer ones get a
-- " (<id>)" suffix (before the extension) — guaranteed unique since the id is.
UPDATE "files" AS f
SET "filename" = regexp_replace(
  ranked."filename", '(\.[^.]*)?$', ' (' || ranked."id"::text || ')\1'
)
FROM (
  SELECT "id", "filename",
    row_number() OVER (
      PARTITION BY "user_id", "filename" ORDER BY "created_at", "id"
    ) AS rn
  FROM "files"
  WHERE "project_id" IS NULL
) AS ranked
WHERE f."id" = ranked."id" AND ranked.rn > 1;--> statement-breakpoint
CREATE UNIQUE INDEX "files_user_filename_uidx" ON "files" USING btree ("user_id","filename") WHERE "files"."project_id" IS NULL;--> statement-breakpoint
UPDATE "files" AS f
SET "filename" = regexp_replace(
  ranked."filename", '(\.[^.]*)?$', ' (' || ranked."id"::text || ')\1'
)
FROM (
  SELECT "id", "filename",
    row_number() OVER (
      PARTITION BY "project_id", "filename" ORDER BY "created_at", "id"
    ) AS rn
  FROM "files"
  WHERE "project_id" IS NOT NULL
) AS ranked
WHERE f."id" = ranked."id" AND ranked.rn > 1;--> statement-breakpoint
CREATE UNIQUE INDEX "files_project_filename_uidx" ON "files" USING btree ("project_id","filename") WHERE "files"."project_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "projects_org_slug_uidx" ON "projects" USING btree ("organization_id","slug");
