import type { archestraApiTypes } from "@archestra/shared";
import { describe, expect, it } from "vitest";
import {
  getToolSource,
  getVisibleCatalogSources,
  hasAppCatalogSources,
} from "./assigned-tools-table.utils";

type InternalMcpCatalogItem =
  archestraApiTypes.GetInternalMcpCatalogResponses["200"][number];

function makeCatalogItem(
  overrides: Partial<InternalMcpCatalogItem>,
): InternalMcpCatalogItem {
  return {
    id: "catalog-1",
    name: "GitHub",
    description: "GitHub tools",
    icon: null,
    serverType: "remote",
    ...overrides,
  } as unknown as InternalMcpCatalogItem;
}

const appCatalogItem = makeCatalogItem({
  id: "catalog-app",
  name: "Task Tracker",
  serverType: "app",
});

describe("getVisibleCatalogSources", () => {
  it("returns an empty array when there are no catalog items", () => {
    expect(getVisibleCatalogSources()).toEqual([]);
  });

  it("filters out the built-in Archestra MCP catalog entry", () => {
    expect(
      getVisibleCatalogSources([
        makeCatalogItem({
          id: "00000000-0000-4000-8000-000000000001",
          name: "Archestra MCP Server",
          description: "Built-in tools",
        }),
        makeCatalogItem({ id: "catalog-1" }),
      ]),
    ).toEqual([makeCatalogItem({ id: "catalog-1" })]);
  });

  it("deduplicates catalog items by id", () => {
    expect(
      getVisibleCatalogSources([
        makeCatalogItem({ id: "catalog-1" }),
        makeCatalogItem({
          id: "catalog-1",
          description: "Duplicate entry",
          icon: "https://example.com/icon.png",
        }),
      ]),
    ).toHaveLength(1);
  });

  it("leaves app backings to the grouped App source", () => {
    expect(
      getVisibleCatalogSources([
        makeCatalogItem({ id: "catalog-1" }),
        appCatalogItem,
      ]).map((item) => item.id),
    ).toEqual(["catalog-1"]);
    expect(hasAppCatalogSources([makeCatalogItem({ id: "catalog-1" })])).toBe(
      false,
    );
    expect(hasAppCatalogSources([appCatalogItem])).toBe(true);
  });
});

describe("getToolSource", () => {
  it("labels an app launch tool with its app", () => {
    expect(
      getToolSource(
        { catalogId: "catalog-app", name: "task_tracker-abcd1234__open" },
        [makeCatalogItem({ id: "catalog-1" }), appCatalogItem],
      ),
    ).toEqual({ kind: "app", appName: "Task Tracker" });
  });

  it("labels a catalog tool with its MCP server", () => {
    expect(
      getToolSource({ catalogId: "catalog-1", name: "github__search" }, [
        makeCatalogItem({ id: "catalog-1" }),
      ]),
    ).toEqual({
      kind: "mcp",
      catalogItem: makeCatalogItem({ id: "catalog-1" }),
    });
  });

  // The bug this guards: an unresolved catalog (an app backing when the viewer
  // cannot read apps, or any catalog they cannot see) used to fall through to
  // "Observed tools" — a label the source filter then contradicted, since those
  // tools are catalog-backed and never match the observed-tools origin.
  it("keeps a tool with an unknown catalog on the MCP source, listed or not", () => {
    // Catalog absent from a loaded list.
    expect(
      getToolSource({ catalogId: "catalog-missing", name: "whatever__open" }, [
        makeCatalogItem({ id: "catalog-1" }),
      ]),
    ).toEqual({ kind: "mcp", catalogItem: undefined });
    // No list at all — the first render, before the catalog query resolves,
    // which is exactly when a wrong badge would flash.
    expect(
      getToolSource({ catalogId: "catalog-missing", name: "whatever__open" }),
    ).toEqual({ kind: "mcp", catalogItem: undefined });
  });

  it("labels a delegation tool with the agent it delegates to", () => {
    expect(
      getToolSource({ catalogId: null, name: "agent__my_assistant" }, []),
    ).toEqual({ kind: "agent", agentName: "my assistant" });
  });

  it("labels a tool with no catalog as observed", () => {
    expect(getToolSource({ catalogId: null, name: "Bash" }, [])).toEqual({
      kind: "observed",
    });
  });
});
