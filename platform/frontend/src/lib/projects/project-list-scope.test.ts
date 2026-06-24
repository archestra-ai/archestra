import { describe, expect, test } from "vitest";
import { parseProjectScope, toApiProjectScope } from "./project-list-scope";

describe("parseProjectScope", () => {
  test("accepts known scopes and defaults unknown/missing to all", () => {
    expect(parseProjectScope("personal")).toBe("personal");
    expect(parseProjectScope("team")).toBe("team");
    expect(parseProjectScope("org")).toBe("org");
    expect(parseProjectScope("all")).toBe("all");
    expect(parseProjectScope(null)).toBe("all");
    expect(parseProjectScope("bogus")).toBe("all");
    // legacy values from a stale URL fall back to all
    expect(parseProjectScope("shared")).toBe("all");
  });
});

describe("toApiProjectScope", () => {
  test("maps all to undefined and passes the rest through", () => {
    expect(toApiProjectScope("all")).toBeUndefined();
    expect(toApiProjectScope("personal")).toBe("personal");
    expect(toApiProjectScope("team")).toBe("team");
    expect(toApiProjectScope("org")).toBe("org");
  });
});
