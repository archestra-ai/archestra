-- Add meta column to tools table for MCP Apps metadata (_meta.ui from tool discovery)
ALTER TABLE tools ADD COLUMN IF NOT EXISTS meta JSONB DEFAULT NULL;

-- Partial index for efficient lookup of tools with MCP App support
CREATE INDEX IF NOT EXISTS idx_tools_meta_has_ui
  ON tools USING btree ((meta IS NOT NULL))
  WHERE meta IS NOT NULL;
