import { describe, expect, test } from "vitest";
import { chunkForBulkStatement } from "./db";

describe("chunkForBulkStatement", () => {
  test("keeps a batch that fits in one statement intact", () => {
    const rows = Array.from({ length: 1000 }, (_, i) => i);

    expect(chunkForBulkStatement(rows)).toEqual([rows]);
  });

  test("splits past the cap without dropping or duplicating a row", () => {
    // The cap exists because Postgres refuses a statement with more than 65535
    // bind parameters, so the split has to be exhaustive: a lost row means a
    // digest silently never gets persisted.
    const rows = Array.from({ length: 2501 }, (_, i) => i);

    const chunks = chunkForBulkStatement(rows);

    expect(chunks.map((chunk) => chunk.length)).toEqual([1000, 1000, 501]);
    expect(chunks.flat()).toEqual(rows);
  });

  test("returns nothing to execute for an empty batch", () => {
    expect(chunkForBulkStatement([])).toEqual([]);
  });
});
