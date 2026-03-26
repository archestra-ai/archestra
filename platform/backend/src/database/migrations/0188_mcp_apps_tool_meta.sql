-- mcp_apps_tool_meta_migration.sql
--
-- Adds a `meta` JSONB column to the tools table for persisting
-- MCP tool metadata including _meta.ui.resourceUri (MCP Apps spec SEP-1865).
--
-- This column stores the raw `_meta` object from the MCP server's
-- tools/list response, which may contain:
--   _meta.ui.resourceUri  — the ui:// resource URI for MCP App rendering
--   _meta.ui.visibility   — ["model"] | ["app"] | ["model", "app"]
--   _meta.ui.csp          — allowed origins for the iframe sandbox
--   annotations           — MCP tool annotations (readOnlyHint, etc.)
--
-- Usage after applying:
--   INSERT INTO tools (name, description, input_schema, meta, ...)
--   VALUES ('my_tool', '...', '{}', '{"ui": {"resourceUri": "ui://..."}}'::jsonb, ...)
--
-- NOTE: Run via drizzle-kit or the existing migration system.
-- File name prefix should follow the next sequential number in your
-- migrations directory (e.g., 0187_mcp_apps_tool_meta.sql).

ALTER TABLE tools
  ADD COLUMN IF NOT EXISTS meta jsonb DEFAULT NULL;

-- Index for fast lookup of tools by their ui:// resourceUri.
-- Used by mcp-client.ts readResource() to find which MCP server
-- handles a given ui:// URI.
CREATE INDEX IF NOT EXISTS tools_meta_ui_resource_uri_idx
  ON tools USING gin ((meta -> 'ui' -> 'resourceUri'));

COMMENT ON COLUMN tools.meta IS
  'MCP tool metadata (_meta from tools/list). Contains _meta.ui.resourceUri '
  'for MCP Apps support (SEP-1865), _meta.ui.visibility, annotations, etc.';
