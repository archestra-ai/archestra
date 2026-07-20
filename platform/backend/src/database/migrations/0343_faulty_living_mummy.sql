-- Existing apps predate the publish/draft feature and are already live. Add the
-- column defaulting to true so they are backfilled live via PG11+ metadata (no
-- row rewrite, no full-table WAL, no lock held for a backfill), then flip the
-- default so apps created afterward start as drafts.
ALTER TABLE "apps" ADD COLUMN "published" boolean DEFAULT true NOT NULL;
--> statement-breakpoint
ALTER TABLE "apps" ALTER COLUMN "published" SET DEFAULT false;