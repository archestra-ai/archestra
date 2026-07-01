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
export const PLAYWRIGHT_MCP_ICON =
  'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="%232EAD33"><path d="M23.996 7.462c-.056.837-.257 2.135-.716 3.85-.995 3.715-4.27 10.874-10.42 9.227-6.15-1.65-5.407-9.487-4.412-13.201.46-1.716.934-2.94 1.305-3.694.42-.853.846-.289 1.815.523.684.573 2.41 1.791 5.011 2.488 2.601.697 4.706.506 5.583.352 1.245-.219 1.897-.494 1.834.455Zm-9.807 3.863s-.127-1.819-1.773-2.286c-1.644-.467-2.613 1.04-2.613 1.04Zm4.058 4.539-7.769-2.172s.446 2.306 3.338 3.153c2.862.836 4.43-.98 4.43-.981Zm2.701-2.51s-.13-1.818-1.773-2.286c-1.644-.469-2.612 1.038-2.612 1.038ZM8.57 18.23c-4.749 1.279-7.261-4.224-8.021-7.08C.197 9.831.044 8.832.003 8.188c-.047-.73.455-.52 1.415-.354.677.118 2.3.261 4.308-.28a11.28 11.28 0 0 0 2.41-.956c-.058.197-.114.4-.17.61-.433 1.618-.827 4.055-.632 6.426-1.976.732-2.267 2.423-2.267 2.423l2.524-.715c.227 1.002.6 1.987 1.15 2.838a5.914 5.914 0 0 1-.171.049Zm-4.188-6.298c1.265-.333 1.363-1.631 1.363-1.631l-3.374.888s.745 1.076 2.01.743Z"/></svg>';

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
