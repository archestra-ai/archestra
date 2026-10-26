import { describe, expect, it } from "vitest";
import { compactPriorities, orderShare, orderSummary } from "./pool-form";

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

describe("orderShare", () => {
  it("splits an order's traffic by weight, among members that are on", () => {
    const members = [
      member(1, 3),
      member(1, 1),
      member(1, 5, false),
      member(2),
    ];
    expect(orderShare(members, 0)).toBe(75);
    expect(orderShare(members, 1)).toBe(25);
    expect(orderShare(members, 2)).toBeNull();
    expect(orderShare(members, 3)).toBe(100);
  });
});

describe("orderSummary", () => {
  it("counts the members and how many go first", () => {
    expect(orderSummary([member(1), member(1), member(2)])).toBe(
      "3 members, 2 on order 1",
    );
    expect(orderSummary([member(1)])).toBe("1 member");
    expect(orderSummary([])).toBe("0 members");
  });
});
