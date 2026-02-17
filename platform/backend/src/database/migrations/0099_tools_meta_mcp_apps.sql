-- Add optional meta column for MCP tool metadata (e.g. _meta.ui.resourceUri for MCP Apps)
ALTER TABLE "tools" ADD COLUMN IF NOT EXISTS "meta" jsonb;
