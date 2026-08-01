import { describe, expect, it } from "vitest";
import { buildDetailTabHref } from "./detail-tab-href";

const href = (tab: string, query = "") =>
  buildDetailTabHref({
    tab,
    pathname: "/mcp/registry/abc",
    searchParams: new URLSearchParams(query),
  });

describe("buildDetailTabHref", () => {
  it("leaves Overview as the bare URL people land on", () => {
    expect(href("overview")).toBe("/mcp/registry/abc");
    expect(href("overview", "tab=usage")).toBe("/mcp/registry/abc");
  });

  it("names the tab for every other panel", () => {
    expect(href("usage")).toBe("/mcp/registry/abc?tab=usage");
    expect(href("credentials", "tab=usage")).toBe(
      "/mcp/registry/abc?tab=credentials",
    );
  });

  it("keeps the targeted install while moving within the logs family", () => {
    expect(href("inspector", "tab=logs&server=install-1")).toBe(
      "/mcp/registry/abc?tab=inspector&server=install-1",
    );
    expect(href("shell", "tab=logs&server=install-1")).toBe(
      "/mcp/registry/abc?tab=shell&server=install-1",
    );
  });

  it("drops the targeted install when leaving the logs family", () => {
    expect(href("overview", "tab=logs&server=install-1")).toBe(
      "/mcp/registry/abc",
    );
    expect(href("credentials", "tab=logs&server=install-1")).toBe(
      "/mcp/registry/abc?tab=credentials",
    );
    expect(href("usage", "tab=logs&server=install-1")).toBe(
      "/mcp/registry/abc?tab=usage",
    );
  });

  /**
   * PageLayout marks a tab active by comparing its href to the current URL, so
   * the href for the open tab has to reproduce that URL exactly — including
   * params it doesn't own.
   */
  it("reproduces the current URL exactly for the tab that is already open", () => {
    expect(href("logs", "tab=logs&server=install-1")).toBe(
      "/mcp/registry/abc?tab=logs&server=install-1",
    );
  });

  it("preserves unrelated params", () => {
    expect(href("usage", "from=card")).toBe(
      "/mcp/registry/abc?from=card&tab=usage",
    );
  });
});
