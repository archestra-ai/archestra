import { describe, expect, it } from "vitest";
import {
  countConnectionFilters,
  type FilterableConnection,
  matchesConnectionFilter,
  matchesConnectionSearch,
} from "./connection-filters";

function connection(
  overrides: Partial<FilterableConnection> = {},
): FilterableConnection {
  return {
    owner: "ada@example.com",
    createdBy: null,
    needsSignIn: false,
    shared: false,
    ...overrides,
  };
}

describe("connection filters", () => {
  it("counts each connection under every kind it belongs to", () => {
    const counts = countConnectionFilters([
      connection(),
      connection({ needsSignIn: true }),
      connection({ owner: "Platform", shared: true }),
      connection({ owner: "Organization", shared: true, needsSignIn: true }),
    ]);

    expect(counts).toEqual({
      all: 4,
      "needs-sign-in": 2,
      personal: 2,
      shared: 2,
    });
  });

  it("keeps a shared connection out of the personal kind and the reverse", () => {
    const personal = connection();
    const shared = connection({ owner: "Platform", shared: true });

    expect(matchesConnectionFilter(personal, "personal")).toBe(true);
    expect(matchesConnectionFilter(personal, "shared")).toBe(false);
    expect(matchesConnectionFilter(shared, "shared")).toBe(true);
    expect(matchesConnectionFilter(shared, "personal")).toBe(false);
  });

  it("finds a connection by part of its owner, whatever the case", () => {
    expect(matchesConnectionSearch(connection(), "  ADA@ex ")).toBe(true);
    expect(matchesConnectionSearch(connection(), "grace")).toBe(false);
  });

  it("finds a shared connection by the person who created it", () => {
    const shared = connection({
      owner: "Platform",
      createdBy: "grace@example.com",
      shared: true,
    });

    expect(matchesConnectionSearch(shared, "grace")).toBe(true);
    expect(matchesConnectionSearch(shared, "platform")).toBe(true);
  });

  it("matches everything while the search is empty", () => {
    expect(matchesConnectionSearch(connection(), "   ")).toBe(true);
  });
});
