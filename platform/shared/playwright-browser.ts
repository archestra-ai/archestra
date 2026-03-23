import { ARCHESTRA_MCP_CATALOG_ID } from "./archestra-mcp-server";

/**
 * Fixed UUID for the Playwright browser preview MCP catalog entry.
 * This ID is constant to ensure consistent catalog lookup across server restarts.
 * Must be a valid UUID format (version 4, variant 8/9/a/b) for Zod validation.
 */
export const PLAYWRIGHT_MCP_CATALOG_ID = "00000000-0000-4000-8000-000000000002";
export const PLAYWRIGHT_MCP_SERVER_NAME = "microsoft__playwright-mcp";

/**
 * Set of all built-in MCP catalog item IDs that are system-managed
 * and should not be modified or deleted by users.
 */
export const BUILT_IN_CATALOG_IDS = new Set([
  ARCHESTRA_MCP_CATALOG_ID,
  PLAYWRIGHT_MCP_CATALOG_ID,
]);

export function isBuiltInCatalogId(id: string): boolean {
  return BUILT_IN_CATALOG_IDS.has(id);
}

export function isPlaywrightCatalogItem(id: string): boolean {
  return id === PLAYWRIGHT_MCP_CATALOG_ID;
}

/**
 * Default browser viewport dimensions used by Playwright MCP in browser preview feature.
 */
export const DEFAULT_BROWSER_PREVIEW_VIEWPORT_WIDTH = 800;
export const DEFAULT_BROWSER_PREVIEW_VIEWPORT_HEIGHT = 800;

/**
 * Approximate height of the browser preview header (title bar + URL bar).
 * Used when calculating popup window dimensions.
 */
export const BROWSER_PREVIEW_HEADER_HEIGHT = 77;

/**
 * Default URL to show when browser preview is opened for a new conversation.
 * Using about:blank ensures no automatic navigation happens until user requests it.
 */
export const DEFAULT_BROWSER_PREVIEW_URL = "about:blank";

/**
 * Check if a tool name is a Playwright/browser MCP tool.
 * Matches tools from Playwright MCP server (e.g., microsoft__playwright-mcp__browser_navigate)
 * and tools with browser_ prefix.
 */
export function isBrowserMcpTool(toolName: string): boolean {
  return toolName.includes("playwright") || toolName.startsWith("browser_");
}
