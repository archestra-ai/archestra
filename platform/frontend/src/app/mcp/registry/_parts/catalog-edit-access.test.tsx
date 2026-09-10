import { PLAYWRIGHT_MCP_CATALOG_ID } from "@archestra/shared";
import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useCanModifyCatalogItem } from "./catalog-edit-access";

type CatalogItem = NonNullable<Parameters<typeof useCanModifyCatalogItem>[0]>;
function catalogItem(overrides: Partial<CatalogItem> = {}): CatalogItem {
  return {
    id: "a326cad4-f47c-4cfa-a950-cc6f98a6e98c",
    scope: "personal",
    authorId: "user-self",
    teams: [],
    effectiveActions: [],
    ...overrides,
  } as unknown as CatalogItem;
}

describe("catalog editing authority", () => {
  it("follows the server's object grant and immediately reflects revocation", () => {
    const catalog = catalogItem({ effectiveActions: ["read", "update"] });
    const { result, rerender } = renderHook(
      (item: CatalogItem) => useCanModifyCatalogItem(item),
      { initialProps: catalog },
    );
    expect(result.current.canModify).toBe(true);
    rerender({ ...catalog, effectiveActions: ["read"] });
    expect(result.current.canModify).toBe(false);
  });

  it("does not infer editing authority from authorship or old team sharing", () => {
    const { result } = renderHook(() =>
      useCanModifyCatalogItem(
        catalogItem({
          scope: "team",
          teams: [{ id: "team-a", name: "Engineering", level: "write" }],
          effectiveActions: ["read", "use"],
        }),
      ),
    );
    expect(result.current.canModify).toBe(false);
  });

  it("keeps managed Playwright immutable even when the server reports update access", () => {
    const { result } = renderHook(() =>
      useCanModifyCatalogItem(
        catalogItem({
          id: PLAYWRIGHT_MCP_CATALOG_ID,
          effectiveActions: ["update"],
        }),
      ),
    );
    expect(result.current.canModify).toBe(false);
  });

  it("denies editing while the resource is unavailable", () => {
    const { result } = renderHook(() => useCanModifyCatalogItem(null));
    expect(result.current.canModify).toBe(false);
  });
});
