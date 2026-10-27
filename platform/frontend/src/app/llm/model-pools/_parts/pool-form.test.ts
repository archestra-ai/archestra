import { describe, expect, it } from "vitest";
import {
  memberOrders,
  orderShare,
  type PoolFormMember,
  removeMember,
  toFormValues,
  toPoolInput,
} from "./pool-form";

function member(
  modelId: string,
  linked = false,
  weight = 1,
  enabled = true,
): PoolFormMember {
  return { providerApiKeyId: "key", modelId, linked, weight, enabled };
}

/** "a b+c d": a alone, b and c linked, d alone. */
function layout(members: PoolFormMember[]): string {
  return members
    .map((row, index) =>
      index === 0 ? row.modelId : `${row.linked ? "+" : " "}${row.modelId}`,
    )
    .join("");
}

describe("memberOrders", () => {
  it("gives linked members the order of the member above", () => {
    expect(
      memberOrders([
        member("a"),
        member("b", true),
        member("c"),
        member("d", true),
        member("e", true),
      ]),
    ).toEqual([1, 1, 2, 2, 2]);
  });
});

describe("toFormValues and toPoolInput", () => {
  it("round-trips priorities through links, in order", () => {
    const values = toFormValues({
      id: "pool",
      organizationId: "org",
      name: "glm-5",
      createdAt: "",
      updatedAt: "",
      virtualApiKeyIds: [],
      members: [5, 1, 5, 9].map((priority, index) => ({
        id: String(index),
        poolId: "pool",
        providerApiKeyId: "key",
        providerApiKeyName: "Key",
        provider: "zhipuai" as const,
        modelId: `m${index}`,
        priority,
        weight: 1,
        enabled: true,
        createdAt: "",
        benchedUntil: null,
        benchReason: null,
      })),
    });
    expect(layout(values.members)).toBe("m1 m0+m2 m3");
    expect(
      toPoolInput(values).members.map((row) => [row.modelId, row.priority]),
    ).toEqual([
      ["m1", 1],
      ["m0", 2],
      ["m2", 2],
      ["m3", 3],
    ]);
  });
});

describe("removeMember", () => {
  it("keeps the remaining members of an order together", () => {
    expect(
      layout(removeMember([member("a"), member("b", true), member("c")], 0)),
    ).toBe("b c");
  });
});

describe("orderShare", () => {
  it("splits an order's traffic by weight, among members that are on", () => {
    const members = [
      member("a", false, 3),
      member("b", true, 1),
      member("c", true, 5, false),
      member("d"),
    ];
    expect(orderShare(members, 0)).toBe(75);
    expect(orderShare(members, 1)).toBe(25);
    expect(orderShare(members, 2)).toBeNull();
    expect(orderShare(members, 3)).toBeNull();
  });
});
