-- Migration: Replace individual OAuth fields with MCP SDK OAuth objects
-- This migration restructures OAuth storage to match @modelcontextprotocol/sdk/shared/auth.js interfaces

-- Remove old individual OAuth fields
ALTER TABLE `mcp_servers` DROP COLUMN `oauth_access_token`;--> statement-breakpoint
ALTER TABLE `mcp_servers` DROP COLUMN `oauth_refresh_token`;--> statement-breakpoint
ALTER TABLE `mcp_servers` DROP COLUMN `oauth_expiry_date`;--> statement-breakpoint
ALTER TABLE `mcp_servers` DROP COLUMN `oauth_discovery_metadata`;--> statement-breakpoint

-- Add new MCP SDK OAuth object fields
ALTER TABLE `mcp_servers` ADD `oauth_tokens` text;--> statement-breakpoint
ALTER TABLE `mcp_servers` ADD `oauth_client_info` text;--> statement-breakpoint
ALTER TABLE `mcp_servers` ADD `oauth_server_metadata` text;--> statement-breakpoint
ALTER TABLE `mcp_servers` ADD `oauth_resource_metadata` text;