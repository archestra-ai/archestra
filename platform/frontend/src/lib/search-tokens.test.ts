import { describe, expect, it } from "vitest";

import { matchesSearchTokens } from "./search-tokens";

describe("matchesSearchTokens", () => {
  it("matches tokens in an order the value does not use", () => {
    // Directory syncs commonly store "Last, First M." while people search
    // "First Last".
    expect(matchesSearchTokens("Ada Lovelace", ["Lovelace, Ada M."])).toBe(
      true,
    );
  });

  it("matches a single token against any part of the value", () => {
    expect(matchesSearchTokens("lovelace", ["Lovelace, Ada M."])).toBe(true);
    expect(matchesSearchTokens("ada", ["Lovelace, Ada M."])).toBe(true);
  });

  it("lets tokens land in different haystacks", () => {
    expect(
      matchesSearchTokens("lovelace analytical", [
        "Ada Lovelace",
        "analytical.engine@example.com",
      ]),
    ).toBe(true);
  });

  it("requires every token to match, so extra words narrow the result", () => {
    expect(matchesSearchTokens("Ada Babbage", ["Lovelace, Ada M."])).toBe(
      false,
    );
  });

  it("ignores case and surrounding whitespace", () => {
    expect(matchesSearchTokens("  ADA   lovelace ", ["Ada Lovelace"])).toBe(
      true,
    );
  });

  it("matches everything for a blank query", () => {
    expect(matchesSearchTokens("   ", ["Ada Lovelace"])).toBe(true);
  });

  it("skips absent haystacks instead of matching on them", () => {
    expect(matchesSearchTokens("ada", [null, undefined, "Ada"])).toBe(true);
    expect(matchesSearchTokens("ada", [null, undefined])).toBe(false);
  });
});
