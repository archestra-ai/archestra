import { describe, expect, test } from "@/test";
import { calculatePaginationMeta, createPaginatedResult } from "./pagination";

describe("Pagination Utilities", () => {
  describe("calculatePaginationMeta", () => {
    test("should calculate metadata for first page", () => {
      const meta = calculatePaginationMeta(100, { limit: 20, offset: 0 });

      expect(meta).toEqual({
        currentPage: 1,
        limit: 20,
        total: 100,
        totalPages: 5,
        hasNext: true,
        hasPrev: false,
      });
    });

    test("should calculate metadata for middle page", () => {
      const meta = calculatePaginationMeta(100, { limit: 20, offset: 40 });

      expect(meta).toEqual({
        currentPage: 3,
        limit: 20,
        total: 100,
        totalPages: 5,
        hasNext: true,
        hasPrev: true,
      });
    });

    test("should calculate metadata for last page", () => {
      const meta = calculatePaginationMeta(100, { limit: 20, offset: 80 });

      expect(meta).toEqual({
        currentPage: 5,
        limit: 20,
        total: 100,
        totalPages: 5,
        hasNext: false,
        hasPrev: true,
      });
    });

    test("should handle partial last page", () => {
      const meta = calculatePaginationMeta(95, { limit: 20, offset: 80 });

      expect(meta).toEqual({
        currentPage: 5,
        limit: 20,
        total: 95,
        totalPages: 5,
        hasNext: false,
        hasPrev: true,
      });
    });

    test("should handle empty result set", () => {
      const meta = calculatePaginationMeta(0, { limit: 20, offset: 0 });

      expect(meta).toEqual({
        currentPage: 1,
        limit: 20,
        total: 0,
        totalPages: 0,
        hasNext: false,
        hasPrev: false,
      });
    });

    test("should handle single page", () => {
      const meta = calculatePaginationMeta(10, { limit: 20, offset: 0 });

      expect(meta).toEqual({
        currentPage: 1,
        limit: 20,
        total: 10,
        totalPages: 1,
        hasNext: false,
        hasPrev: false,
      });
    });

    test("should handle custom limit", () => {
      const meta = calculatePaginationMeta(250, { limit: 50, offset: 100 });

      expect(meta).toEqual({
        currentPage: 3,
        limit: 50,
        total: 250,
        totalPages: 5,
        hasNext: true,
        hasPrev: true,
      });
    });
  });

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
