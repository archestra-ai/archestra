import { describe, expect, test } from "vitest";
import {
  isBrowserMcpTool,
  isBuiltInCatalogId,
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

  test("recognizes the built-in playwright catalog item", () => {
    expect(isPlaywrightCatalogItem(PLAYWRIGHT_MCP_CATALOG_ID)).toBe(true);
    expect(isBuiltInCatalogId(PLAYWRIGHT_MCP_CATALOG_ID)).toBe(true);
  });
});
