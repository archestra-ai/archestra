import { describe, expect, test } from "@/test";
import { createPaginatedResult } from "./pagination";

describe("Pagination Utilities", () => {
  describe("createPaginatedResult", () => {
    test("should create paginated result with data and metadata", () => {
      const data = [
        { id: "1", name: "Item 1" },
        { id: "2", name: "Item 2" },
      ];
      const result = createPaginatedResult(data, 100, {
        limit: 20,
        offset: 0,
      });

      expect(result).toEqual({
        data,
        pagination: {
          currentPage: 1,
          limit: 20,
          total: 100,
          totalPages: 5,
          hasNext: true,
          hasPrev: false,
        },
      });
    });

    test("should work with empty data array", () => {
      const result = createPaginatedResult([], 0, { limit: 20, offset: 0 });

      expect(result).toEqual({
        data: [],
        pagination: {
          currentPage: 1,
          limit: 20,
          total: 0,
          totalPages: 0,
          hasNext: false,
          hasPrev: false,
        },
      });
    });

    test("should maintain data type", () => {
      interface TestItem {
        id: string;
        value: number;
      }

      const data: TestItem[] = [
        { id: "1", value: 100 },
        { id: "2", value: 200 },
      ];

      const result = createPaginatedResult(data, 50, {
        limit: 20,
        offset: 20,
      });

      expect(result.data).toEqual(data);
      expect(result.pagination.currentPage).toBe(2);
    });
  });
});
