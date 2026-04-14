import { describe, expect, test } from "vitest";
import {
  BROWSER_TOOLS_WITH_LARGE_RESULTS,
  isBrowserMcpTool,
  isBuiltInCatalogId,
  isLargeResultBrowserMcpTool,
  isPlaywrightCatalogItem,
  PLAYWRIGHT_MCP_CATALOG_ID,
} from "./playwright-browser";

describe("playwright browser helpers", () => {
  test("matches Playwright/browser tools", () => {
    expect(
      isBrowserMcpTool("microsoft__playwright-mcp__browser_navigate"),
    ).toBe(true);
    expect(isBrowserMcpTool("browser_click")).toBe(true);
    expect(isBrowserMcpTool("github__list_issues")).toBe(false);
  });

  test("matches the shared large-result browser tool subset", () => {
    expect(
      isLargeResultBrowserMcpTool(
        "microsoft__playwright-mcp__browser_snapshot",
      ),
    ).toBe(true);
    expect(isLargeResultBrowserMcpTool("browser_click")).toBe(true);
    expect(isLargeResultBrowserMcpTool("browser_navigate_back")).toBe(false);
    expect(isLargeResultBrowserMcpTool("github__list_issues")).toBe(false);
    expect(BROWSER_TOOLS_WITH_LARGE_RESULTS).toContain("browser_tabs");
  });

  test("recognizes the built-in playwright catalog item", () => {
    expect(isPlaywrightCatalogItem(PLAYWRIGHT_MCP_CATALOG_ID)).toBe(true);
    expect(isBuiltInCatalogId(PLAYWRIGHT_MCP_CATALOG_ID)).toBe(true);
  });
});
