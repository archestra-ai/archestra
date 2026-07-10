ALTER TABLE "mcp_catalog_team" ADD COLUMN "level" text DEFAULT 'write' NOT NULL;--> statement-breakpoint
-- NOT VALID keeps the add rolling-safe (no full-table validation); the column
-- is new and every row takes the 'write' default, so nothing violates it, and
-- the constraint still enforces the domain on all future writes.
ALTER TABLE "mcp_catalog_team" ADD CONSTRAINT "mcp_catalog_team_level_check" CHECK ("mcp_catalog_team"."level" in ('use', 'write')) NOT VALID;