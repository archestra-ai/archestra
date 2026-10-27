import { DrizzleQueryError } from "drizzle-orm/errors";
import { describe, expect, test } from "vitest";
import {
  chunkForBulkStatement,
  clientErrorMessage,
  FAILED_QUERY_CLIENT_MESSAGE,
  hasFailedQueryText,
} from "./db";

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

describe("clientErrorMessage", () => {
  const queryError = new DrizzleQueryError(
    'select "secret" from "secret" where "id" = $1',
    ["secret-id-1"],
    new Error("timeout"),
  );

  test("replaces a failed query's text, also when a wrapper copies it", () => {
    expect(hasFailedQueryText(queryError)).toBe(true);
    expect(clientErrorMessage(queryError, "Internal error")).toBe(
      FAILED_QUERY_CLIENT_MESSAGE,
    );
    expect(
      clientErrorMessage(
        new Error(`Hard reset failed: ${queryError.message}`),
        "Internal error",
      ),
    ).toBe(FAILED_QUERY_CLIENT_MESSAGE);
  });

  test("keeps other messages, including a wrapper whose cause is the query", () => {
    expect(
      clientErrorMessage(
        new Error("Could not save the key", { cause: queryError }),
        "Internal error",
      ),
    ).toBe("Could not save the key");
    expect(clientErrorMessage(new Error("Agent not found"), "x")).toBe(
      "Agent not found",
    );
  });

  test("uses the fallback for a non-Error or an empty message", () => {
    expect(clientErrorMessage("boom", "Internal error")).toBe("Internal error");
    expect(clientErrorMessage(new Error(""), "Internal error")).toBe(
      "Internal error",
    );
  });
});
