-- Enable pg_trgm extension for trigram-based text similarity and ILIKE optimization
-- Uses DO block to gracefully handle environments where extension isn't available (e.g., PGLite in tests)
DO $$
BEGIN
  CREATE EXTENSION IF NOT EXISTS pg_trgm;
EXCEPTION WHEN others THEN
  RAISE NOTICE 'pg_trgm extension not available, skipping trigram indexes';
END$$;

--> statement-breakpoint

-- Create GIN indexes with trigram operator class for efficient ILIKE queries on JSONB text
-- These indexes support the ::text ILIKE '%pattern%' queries used in interaction search
-- Only created if pg_trgm extension is available
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm') THEN
    CREATE INDEX IF NOT EXISTS "interactions_request_trgm_idx" ON "interactions" USING gin ((request::text) gin_trgm_ops);
    CREATE INDEX IF NOT EXISTS "interactions_response_trgm_idx" ON "interactions" USING gin ((response::text) gin_trgm_ops);
  END IF;
END$$;
