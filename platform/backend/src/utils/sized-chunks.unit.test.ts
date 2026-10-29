import { describe, expect, test } from "vitest";
import { sizedChunks } from "./sized-chunks";

const chunks = (sizes: number[], maxRows: number, maxBytes: number) => [
  ...sizedChunks(sizes, { maxRows, maxBytes }, (size) => size),
];

describe("sizedChunks", () => {
  test("cuts at the row cap", () => {
    expect(chunks([1, 1, 1, 1, 1], 2, 100)).toEqual([[1, 1], [1, 1], [1]]);
  });

  test("cuts before the byte cap is exceeded", () => {
    expect(chunks([4, 4, 4, 2, 2], 10, 8)).toEqual([
      [4, 4],
      [4, 2, 2],
    ]);
  });

  test("lets a row over the byte cap travel alone", () => {
    expect(chunks([3, 20, 3], 10, 8)).toEqual([[3], [20], [3]]);
  });

  test("yields nothing for no rows", () => {
    expect(chunks([], 10, 8)).toEqual([]);
  });
});
