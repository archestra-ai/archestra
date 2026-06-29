import { describe, expect, test } from "vitest";
import { calculatePaginationMeta } from "./pagination";

describe("pagination", () => {
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
});
