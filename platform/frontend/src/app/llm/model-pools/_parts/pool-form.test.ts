import { describe, expect, it } from "vitest";
import {
  compactPriorities,
  roleLabel,
  roleShare,
  roleSummary,
} from "./pool-form";

function member(priority: number, weight = 1, enabled = true) {
  return { providerApiKeyId: "key", modelId: "m", priority, weight, enabled };
}

describe("compactPriorities", () => {
  it("renumbers priorities 1, 2, 3 in the same order", () => {
    const members = [member(5), member(1), member(40), member(5)];
    expect(compactPriorities(members).map((m) => m.priority)).toEqual([
      2, 1, 3, 2,
    ]);
  });
});

describe("roleLabel", () => {
  it.each([
    [1, "Primary"],
    [2, "Fallback"],
    [3, "Fallback 2"],
  ])("names priority %i %j", (priority, label) => {
    expect(roleLabel(priority)).toBe(label);
  });
});

describe("roleShare", () => {
  it("splits a role's traffic by weight, among members that are on", () => {
    const members = [
      member(1, 3),
      member(1, 1),
      member(1, 5, false),
      member(2),
    ];
    expect(roleShare(members, 0)).toBe(75);
    expect(roleShare(members, 1)).toBe(25);
    expect(roleShare(members, 2)).toBeNull();
    expect(roleShare(members, 3)).toBe(100);
  });
});

describe("roleSummary", () => {
  it("counts primaries and fallbacks", () => {
    expect(roleSummary([member(1), member(1), member(2)])).toBe(
      "2 primary, 1 fallback",
    );
    expect(roleSummary([member(1)])).toBe("1 primary");
    expect(roleSummary([])).toBe("No members");
  });
});
