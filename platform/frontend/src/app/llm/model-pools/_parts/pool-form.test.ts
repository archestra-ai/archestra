import { describe, expect, it } from "vitest";
import {
  isValidSeconds,
  orderShare,
  type PoolFormMember,
  toFormValues,
  toPoolInput,
} from "./pool-form";

function member(
  modelId: string,
  priority: number,
  weight = 1,
  enabled = true,
): PoolFormMember {
  return { providerApiKeyId: "key", modelId, priority, weight, enabled };
}

describe("toFormValues and toPoolInput", () => {
  it("renumbers orders 1, 2, 3 and lists members by order", () => {
    const values = toFormValues({
      id: "pool",
      organizationId: "org",
      name: "glm-5",
      streamTimeoutSeconds: null,
      timeoutSeconds: null,
      cooldownSeconds: null,
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

describe("a pool's timing", () => {
  it("sends blank as null, to keep the default", () => {
    expect(
      toPoolInput({
        name: "glm-5",
        members: [],
        streamTimeoutSeconds: "45",
        timeoutSeconds: "",
        cooldownSeconds: "300",
      }),
    ).toMatchObject({
      streamTimeoutSeconds: 45,
      timeoutSeconds: null,
      cooldownSeconds: 300,
    });
  });

  it.each([
    ["streamTimeoutSeconds", "", true],
    ["streamTimeoutSeconds", "1800", true],
    ["streamTimeoutSeconds", "1801", false],
    ["cooldownSeconds", "3600", true],
    ["cooldownSeconds", "0", false],
  ] as const)("%s %j is valid: %s", (timing, value, valid) => {
    expect(isValidSeconds(timing, value)).toBe(valid);
  });
});

describe("orderShare", () => {
  it("splits an order's traffic by weight, among members that are on", () => {
    const members = [
      member("a", 1, 3),
      member("b", 1, 1),
      member("c", 1, 5, false),
      member("d", 2),
    ];
    expect(orderShare(members, 0)).toBe(75);
    expect(orderShare(members, 1)).toBe(25);
    expect(orderShare(members, 2)).toBeNull();
    expect(orderShare(members, 3)).toBeNull();
  });
});
