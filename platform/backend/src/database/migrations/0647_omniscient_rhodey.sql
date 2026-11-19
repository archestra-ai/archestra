-- Nullable, no default: metadata-only on the write-hot interactions table, no
-- rewrite. Older rows stay NULL and read as not failed.
ALTER TABLE "interactions" ADD COLUMN "failed" boolean;