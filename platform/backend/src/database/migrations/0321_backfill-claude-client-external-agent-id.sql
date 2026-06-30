-- Custom SQL migration file, put your code below! --
-- Backfill client-app attribution for historical Claude rows. Client identity
-- now lives in external_agent_id; before this change Claude clients were only
-- inferable from session_source ('claude_code' / 'claude_desktop'), which was
-- conflated with session-id provenance. Move that signal into external_agent_id
-- as the generic "anthropic_claude" so the /llm/logs Client filter and badges
-- work on old data. Only touch rows with no external_agent_id so a
-- caller-supplied X-Archestra-Agent-Id is never overwritten. session_source is
-- intentionally left unchanged (read paths still treat the legacy values as Claude).
-- Idempotent via the IS NULL guard + the fixed value.
-- NOTE: keep 'anthropic_claude' in sync with CLAUDE_CLIENT_ID (@archestra/shared).
UPDATE "interactions"
SET "external_agent_id" = 'anthropic_claude'
WHERE "external_agent_id" IS NULL
  AND "session_source" IN ('claude_code', 'claude_desktop');
