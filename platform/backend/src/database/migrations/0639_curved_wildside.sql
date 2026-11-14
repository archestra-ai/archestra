-- IF NOT EXISTS: release/1.4 carries the same column in its own migration, so a
-- 1.4 database that already has it upgrades through this one as a no-op.
ALTER TABLE "internal_mcp_catalog" ADD COLUMN IF NOT EXISTS "tool_prefix" text;
