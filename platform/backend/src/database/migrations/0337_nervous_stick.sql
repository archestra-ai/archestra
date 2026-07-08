ALTER TABLE "tools" ADD COLUMN "raw_name" text;
--> statement-breakpoint
-- Backfill raw_name for existing namespaced tool rows by taking everything after
-- the LAST "__" in the slugified name (the greedy ".*__" consumes up to the final
-- separator). Rows whose name has no "__" are left NULL; dispatch falls back to
-- splitting name when raw_name is null, so this is best-effort and self-heals on
-- the next tool re-sync/reload for any legacy name whose raw part itself contained
-- "__".
UPDATE "tools"
SET "raw_name" = substring("name" from '^.*__(.*)$')
WHERE "name" LIKE '%\_\_%';
