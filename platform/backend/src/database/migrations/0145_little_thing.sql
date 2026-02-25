-- Idempotent migration: update Playwright MCP catalog item to the current pinned config.
-- The seed no longer overwrites on restart (onConflictDoNothing), so this migration
-- ensures existing deployments get the latest config applied once.
UPDATE internal_mcp_catalog
SET local_config = '{
  "dockerImage": "mcr.microsoft.com/playwright/mcp@sha256:50fee3932984dbf40fe67be11fe22d0050eca40705cf108099d7a1e0fe6a181c",
  "transportType": "streamable-http",
  "command": "node",
  "arguments": [
    "cli.js",
    "--headless",
    "--browser",
    "chromium",
    "--no-sandbox",
    "--host",
    "0.0.0.0",
    "--port",
    "8080",
    "--allowed-hosts",
    "*",
    "--isolated"
  ],
  "httpPort": 8080
}'::jsonb,
    name = 'microsoft__playwright-mcp',
    description = 'Browser automation for chat - each user gets their own isolated browser session',
    server_type = 'local',
    requires_auth = false
WHERE id = '00000000-0000-4000-8000-000000000002';
