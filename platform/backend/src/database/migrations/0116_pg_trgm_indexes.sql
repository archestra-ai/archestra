-- Enable pg_trgm extension for trigram-based text similarity and ILIKE optimization
-- Uses DO block to gracefully handle environments where extension isn't available (e.g., PGLite in tests)
DO $$
BEGIN
  CREATE EXTENSION IF NOT EXISTS pg_trgm;
EXCEPTION WHEN others THEN
  RAISE NOTICE 'pg_trgm extension not available, skipping trigram indexes';
END$$;

--> statement-breakpoint

-- Create GIN indexes with trigram operator class for efficient ILIKE queries
-- These indexes support the ::text ILIKE '%pattern%' queries used in search
-- Only created if pg_trgm extension is available
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm') THEN
    -- Interactions table indexes (for LLM proxy logs search)
    CREATE INDEX IF NOT EXISTS "interactions_request_trgm_idx" ON "interactions" USING gin ((request::text) gin_trgm_ops);
    CREATE INDEX IF NOT EXISTS "interactions_response_trgm_idx" ON "interactions" USING gin ((response::text) gin_trgm_ops);

    -- Conversations table index (for chat title search in LLM proxy logs)
    CREATE INDEX IF NOT EXISTS "conversations_title_trgm_idx" ON "conversations" USING gin (title gin_trgm_ops);

    -- MCP tool calls table indexes (for MCP gateway logs search)
    CREATE INDEX IF NOT EXISTS "mcp_tool_calls_method_trgm_idx" ON "mcp_tool_calls" USING gin (method gin_trgm_ops);
    CREATE INDEX IF NOT EXISTS "mcp_tool_calls_mcp_server_name_trgm_idx" ON "mcp_tool_calls" USING gin (mcp_server_name gin_trgm_ops);
    CREATE INDEX IF NOT EXISTS "mcp_tool_calls_tool_result_trgm_idx" ON "mcp_tool_calls" USING gin ((tool_result::text) gin_trgm_ops);
  END IF;
END$$;
