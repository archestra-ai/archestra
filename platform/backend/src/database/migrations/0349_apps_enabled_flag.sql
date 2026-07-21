-- Apps are enabled (live) by default: existing apps were already live, and new
-- apps stay live on create. Adding the column with a constant default backfills
-- every existing row via PG11+ metadata — no row rewrite, no full-table WAL.
ALTER TABLE "apps" ADD COLUMN "enabled" boolean DEFAULT true NOT NULL;