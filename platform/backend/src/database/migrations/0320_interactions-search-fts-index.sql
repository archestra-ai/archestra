-- Custom SQL migration file, put your code below! --

-- Full-text search index for /llm/logs message search.
--
-- The previous approach searched `request::text ILIKE '%term%'` / `response::text
-- ILIKE '%term%'` backed by trigram GIN indexes. For a broad term the trigram
-- recheck re-casts the (multi-MB, mostly tool-schema/metadata) JSONB to text on
-- every matching row, which on a large `interactions` table exceeds the
-- statement_timeout. See InteractionModel.getSessions.
--
-- Instead, index a tsvector built ONLY from the message-bearing JSONB subtrees
-- (excluding the heavy `tools`/`system` metadata), across the provider shapes:
--   request:  messages (openai/anthropic), contents (gemini)
--   response: choices (openai), content (anthropic), candidates (gemini),
--             output (bedrock converse)
-- `left(..., 900000)` keeps the input under tsvector's ~1MB-per-document limit so
-- a very long conversation can never error the write. `to_tsvector('english', …)`
-- is IMMUTABLE (explicit regconfig), so it is valid in an expression index.
--
-- getSessions queries the IDENTICAL expression with `@@ websearch_to_tsquery(...)`
-- so the planner uses this index. Built non-concurrently to match the existing
-- interactions trigram indexes (drizzle-kit runs migrations in a transaction, so
-- CONCURRENTLY is not available here); build in a maintenance window if needed.
CREATE INDEX IF NOT EXISTS "interactions_search_fts_idx" ON "interactions" USING gin (
  to_tsvector(
    'english',
    left(
      coalesce(("request" -> 'messages')::text, '') || ' ' ||
      coalesce(("request" -> 'contents')::text, '') || ' ' ||
      coalesce(("response" -> 'choices')::text, '') || ' ' ||
      coalesce(("response" -> 'content')::text, '') || ' ' ||
      coalesce(("response" -> 'candidates')::text, '') || ' ' ||
      coalesce(("response" -> 'output')::text, ''),
      900000
    )
  )
);
