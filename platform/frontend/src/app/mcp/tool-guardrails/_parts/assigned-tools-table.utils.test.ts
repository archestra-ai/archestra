import type { archestraApiTypes } from "@shared";
import { describe, expect, it } from "vitest";
import { getVisibleCatalogSources } from "./assigned-tools-table.utils";

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
    ...overrides,
  } as unknown as InternalMcpCatalogItem;
}

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
});
