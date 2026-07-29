-- drizzle-migration-linter: allow-breaking
-- drizzle-migration-linter: reason=the index is partial on slug IS NOT NULL, and an older writer never sets slug, so it cannot violate it; the UPDATE above dedupes existing rows in the same transaction, so a residual duplicate aborts this migration instead of shipping
ALTER TABLE "apps" ADD COLUMN "slug" text;--> statement-breakpoint
-- Backfill mirrors AppModel.generateUniqueSlug: urlSlugify the name (lowercase,
-- non-alphanumeric runs to a hyphen, ends trimmed), truncate to leave room for
-- the collision suffix, then re-trim the hyphen a mid-word cut can leave.
WITH derived AS (
  SELECT
    "id",
    "organization_id",
    "created_at",
    btrim(
      substr(btrim(regexp_replace(lower("name"), '[^a-z0-9]+', '-', 'g'), '-'), 1, 93),
      '-'
    ) AS candidate
  FROM "apps"
  WHERE "deleted_at" IS NULL
), guarded AS (
  -- Everything AppSlugSchema refuses must be unreachable by derivation too: an
  -- empty slugification, a segment the /a/ router already owns, and a UUID
  -- shape, which would shadow the app owning that id when the run page resolves
  -- a segment against id OR slug.
  SELECT
    "id",
    "organization_id",
    "created_at",
    CASE
      WHEN candidate = '' THEN 'app'
      WHEN candidate = 'catalog' THEN 'app'
      WHEN candidate ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN 'app'
      ELSE candidate
    END AS base
  FROM derived
), ranked AS (
  SELECT
    "id",
    base,
    row_number() OVER (
      PARTITION BY "organization_id", base
      ORDER BY "created_at", "id"
    ) AS rn
  FROM guarded
)
UPDATE "apps" AS a
SET "slug" = CASE
    WHEN r.rn = 1 THEN r.base
    ELSE r.base || '-' || substr(replace(a."id"::text, '-', ''), 1, 6)
  END
FROM ranked AS r
WHERE a."id" = r."id";--> statement-breakpoint
CREATE UNIQUE INDEX "apps_org_slug_uidx" ON "apps" USING btree ("organization_id","slug") WHERE "apps"."slug" IS NOT NULL AND "apps"."deleted_at" IS NULL;
