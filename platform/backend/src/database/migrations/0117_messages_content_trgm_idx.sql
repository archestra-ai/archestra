-- Create GIN index for messages content for efficient ILIKE queries
-- Uses DO block to gracefully handle environments where extension isn't available
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm') THEN
    -- Create GIN index with trigram operator class on messages.content JSONB cast to text
    -- This supports ILIKE '%pattern%' queries used in conversation search
    CREATE INDEX IF NOT EXISTS "messages_content_trgm_idx" ON "messages" USING gin ((content::text) gin_trgm_ops);
  END IF;
END$$;