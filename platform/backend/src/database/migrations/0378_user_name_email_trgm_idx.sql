-- Trigram indexes backing the member/user search (GET /api/members?name=).
--
-- That search matches each whitespace-separated token with ILIKE '%token%'.
-- A leading wildcard makes the btree unique index on "user"."email" useless and
-- "user"."name" had no index at all, so every keystroke sequentially scanned the
-- whole roster — and tokenizing multiplies that by the number of words typed.
--
-- Guarded the same way as 0116_pg_trgm_indexes.sql: pg_trgm is unavailable in
-- the PGLite test harness, where the sequential scan is fine anyway.
--
-- "user" is a small, low-write table (unlike interactions, where GIN write
-- amplification forced the payload trigram indexes to be dropped), so the
-- write-side cost here is negligible.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm') THEN
    CREATE INDEX IF NOT EXISTS "user_name_trgm_idx" ON "user" USING gin (name gin_trgm_ops);
    CREATE INDEX IF NOT EXISTS "user_email_trgm_idx" ON "user" USING gin (email gin_trgm_ops);
  END IF;
END$$;
