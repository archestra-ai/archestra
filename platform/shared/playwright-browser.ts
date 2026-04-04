import { ARCHESTRA_MCP_CATALOG_ID } from "./archestra-mcp-server";
import { buildFullToolName, parseFullToolName } from "./utils";

/**
 * Fixed UUID for the Playwright browser preview MCP catalog entry.
 * This ID is constant to ensure consistent catalog lookup across server restarts.
 * Must be a valid UUID format (version 4, variant 8/9/a/b) for Zod validation.
 */
export const PLAYWRIGHT_MCP_CATALOG_ID = "00000000-0000-4000-8000-000000000002";
export const PLAYWRIGHT_MCP_SERVER_NAME = buildFullToolName(
  "microsoft",
  "playwright-mcp",
);

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
 * Browser tools that commonly produce large snapshot-like outputs and should be
 * treated specially when trimming stored history or summarizing old tool
 * results.
 */
export const BROWSER_TOOLS_WITH_LARGE_RESULTS = [
  "browser_snapshot",
  "browser_navigate",
  "browser_take_screenshot",
  "browser_tabs",
  "browser_click",
  "browser_type",
  "browser_select_option",
  "browser_hover",
  "browser_drag",
  "browser_scroll",
  "browser_wait_for",
  "browser_press_key",
  "browser_evaluate",
] as const;

export type BrowserToolWithLargeResult =
  (typeof BROWSER_TOOLS_WITH_LARGE_RESULTS)[number];

/**
 * Check if a tool name is a Playwright/browser MCP tool.
 * Matches tools from Playwright MCP server (e.g., microsoft__playwright-mcp__browser_navigate)
 * and tools with browser_ prefix.
 */
export function isBrowserMcpTool(toolName: string): boolean {
  return toolName.includes("playwright") || toolName.startsWith("browser_");
}

export function isLargeResultBrowserMcpTool(toolName: string): boolean {
  const normalizedName = parseFullToolName(toolName).toolName.toLowerCase();
  return (
    BROWSER_TOOLS_WITH_LARGE_RESULTS as readonly BrowserToolWithLargeResult[]
  ).includes(normalizedName as BrowserToolWithLargeResult);
}
