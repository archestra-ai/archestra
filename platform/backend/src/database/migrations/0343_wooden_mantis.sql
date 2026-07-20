-- Existing apps predate the enable/disable feature and are already live. Add
-- the column defaulting to true so they are backfilled enabled via PG11+
-- metadata (no row rewrite, no full-table WAL, no lock held for a backfill),
-- then flip the default so apps created afterward start disabled.
ALTER TABLE "apps" ADD COLUMN "enabled" boolean DEFAULT true NOT NULL;
--> statement-breakpoint
ALTER TABLE "apps" ALTER COLUMN "enabled" SET DEFAULT false;