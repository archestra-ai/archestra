import { describe, expect, test } from "vitest";
import ModelPoolUsageModel from "./model-pool-usage";

describe("model pool routing usage", () => {
  test("concurrent completion updates are additive and survive member row replacement without leaking across pools", async () => {
    const member = {
      memberId: "member",
      providerApiKeyId: "connection",
      modelId: "model",
    };
    await Promise.all(
      [3, 7, 11].map((tokens) =>
        ModelPoolUsageModel.record({ poolId: "pool", ...member, tokens }),
      ),
    );
    expect(
      (await ModelPoolUsageModel.read("pool", [member])).get("member"),
    ).toBe(21);
    expect(
      (
        await ModelPoolUsageModel.read("pool", [
          { ...member, memberId: "replaced" },
        ])
      ).get("replaced"),
    ).toBe(21);
    expect(
      (await ModelPoolUsageModel.read("other-pool", [member])).get("member"),
    ).toBe(0);
    expect(
      (
        await ModelPoolUsageModel.read("pool", [
          { ...member, modelId: "other-model" },
        ])
      ).get("member"),
    ).toBe(0);
  });
});
