import { describe, expect, test } from "@/test";
import InternalMcpCatalogModel from "./internal-mcp-catalog";

describe("InternalMcpCatalogModel", () => {
  describe("getByIds", () => {
    test("returns Map of catalog items by ID", async ({
      makeInternalMcpCatalog,
    }) => {
      const catalog1 = await makeInternalMcpCatalog({
        name: "test-catalog-1",
        serverType: "remote",
      });
      const catalog2 = await makeInternalMcpCatalog({
        name: "test-catalog-2",
        serverType: "local",
      });
      const nonExistentId = "00000000-0000-0000-0000-000000000000";

      const catalogItemsMap = await InternalMcpCatalogModel.getByIds([
        catalog1.id,
        catalog2.id,
        nonExistentId,
      ]);

      expect(catalogItemsMap).toBeInstanceOf(Map);
      expect(catalogItemsMap.size).toBe(2);
      expect(catalogItemsMap.has(catalog1.id)).toBe(true);
      expect(catalogItemsMap.has(catalog2.id)).toBe(true);
      expect(catalogItemsMap.has(nonExistentId)).toBe(false);

      const item1 = catalogItemsMap.get(catalog1.id);
      expect(item1).toBeDefined();
      expect(item1?.id).toBe(catalog1.id);
      expect(item1?.name).toBe("test-catalog-1");
      expect(item1?.serverType).toBe("remote");

      const item2 = catalogItemsMap.get(catalog2.id);
      expect(item2).toBeDefined();
      expect(item2?.id).toBe(catalog2.id);
      expect(item2?.name).toBe("test-catalog-2");
      expect(item2?.serverType).toBe("local");
    });

    test("returns empty Map for empty input", async () => {
      const catalogItemsMap = await InternalMcpCatalogModel.getByIds([]);

      expect(catalogItemsMap).toBeInstanceOf(Map);
      expect(catalogItemsMap.size).toBe(0);
    });

    test("returns empty Map when no catalog items exist", async () => {
      const nonExistentId1 = "00000000-0000-0000-0000-000000000000";
      const nonExistentId2 = "00000000-0000-0000-0000-000000000001";

      const catalogItemsMap = await InternalMcpCatalogModel.getByIds([
        nonExistentId1,
        nonExistentId2,
      ]);

      expect(catalogItemsMap).toBeInstanceOf(Map);
      expect(catalogItemsMap.size).toBe(0);
    });

    test("handles duplicate IDs in input", async ({
      makeInternalMcpCatalog,
    }) => {
      const catalog = await makeInternalMcpCatalog({
        name: "test-catalog",
        serverType: "remote",
      });

      const catalogItemsMap = await InternalMcpCatalogModel.getByIds([
        catalog.id,
        catalog.id,
        catalog.id,
      ]);

      expect(catalogItemsMap.size).toBe(1);
      expect(catalogItemsMap.has(catalog.id)).toBe(true);
      expect(catalogItemsMap.get(catalog.id)?.id).toBe(catalog.id);
    });
  });
});
