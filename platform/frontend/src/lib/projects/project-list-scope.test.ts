import { describe, expect, test } from "vitest";
import {
  parseProjectScope,
  scopeUsesPinnedGrouping,
  toApiProjectScope,
} from "./project-list-scope";

describe("parseProjectScope", () => {
  test("accepts known scopes and defaults unknown/missing to all", () => {
    expect(parseProjectScope("personal")).toBe("personal");
    expect(parseProjectScope("shared")).toBe("shared");
    expect(parseProjectScope("others")).toBe("others");
    expect(parseProjectScope("all")).toBe("all");
    expect(parseProjectScope(null)).toBe("all");
    expect(parseProjectScope("bogus")).toBe("all");
  });
});

describe("toApiProjectScope", () => {
  test("maps all to undefined and passes the rest through", () => {
    expect(toApiProjectScope("all")).toBeUndefined();
    expect(toApiProjectScope("personal")).toBe("personal");
    expect(toApiProjectScope("shared")).toBe("shared");
    expect(toApiProjectScope("others")).toBe("others");
  });
});

describe("scopeUsesPinnedGrouping", () => {
  test("is on everywhere except the admin others view", () => {
    expect(scopeUsesPinnedGrouping("all")).toBe(true);
    expect(scopeUsesPinnedGrouping("personal")).toBe(true);
    expect(scopeUsesPinnedGrouping("shared")).toBe(true);
    expect(scopeUsesPinnedGrouping("others")).toBe(false);
  });
});
