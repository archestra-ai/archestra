-- Add meta column to tools table for MCP Apps support.
-- Stores _meta and annotations from upstream MCP servers.
-- Enables MCP Apps: tools declare interactive UIs via _meta.ui.resourceUri.
ALTER TABLE "tools" ADD COLUMN "meta" jsonb;
