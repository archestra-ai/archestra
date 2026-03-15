import { describe, expect, it } from "vitest";
import { calculatePaginationMeta } from "./pagination";

describe("calculatePaginationMeta", () => {
  it("calculates the first page correctly", () => {
    expect(
      calculatePaginationMeta({
        limit: 10,
        offset: 0,
        total: 23,
      }),
    ).toEqual({
      currentPage: 1,
      limit: 10,
      total: 23,
      totalPages: 3,
      hasNext: true,
      hasPrev: false,
    });
  });

  it("calculates middle pages correctly", () => {
    expect(
      calculatePaginationMeta({
        limit: 10,
        offset: 10,
        total: 23,
      }),
    ).toEqual({
      currentPage: 2,
      limit: 10,
      total: 23,
      totalPages: 3,
      hasNext: true,
      hasPrev: true,
    });
  });

  it("returns no next page when there are zero results", () => {
    expect(
      calculatePaginationMeta({
        limit: 10,
        offset: 0,
        total: 0,
      }),
    ).toEqual({
      currentPage: 1,
      limit: 10,
      total: 0,
      totalPages: 0,
      hasNext: false,
      hasPrev: false,
    });
  });
});
