import { sql } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import db from "@/database";
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
  test("deployment tuple boundaries keep similar identifiers separate", async () => {
    const first = { memberId: "first", providerApiKeyId: "a:b", modelId: "c" };
    const second = {
      memberId: "second",
      providerApiKeyId: "a",
      modelId: "b:c",
    };
    await ModelPoolUsageModel.record({ poolId: "pool", ...first, tokens: 7 });
    await ModelPoolUsageModel.record({ poolId: "pool", ...second, tokens: 11 });
    const usage = await ModelPoolUsageModel.read("pool", [first, second]);
    expect(usage.get("first")).toBe(7);
    expect(usage.get("second")).toBe(11);
  });
  test("malformed routing hints do not reject requests and the next completion repairs the counter", async () => {
    const member = {
      memberId: "member",
      providerApiKeyId: "connection",
      modelId: "model",
    };
    for (const value of [
      "not-json",
      JSON.stringify({ value: { minute: 1, tokens: "invalid" } }),
    ]) {
      await ModelPoolUsageModel.record({
        poolId: "pool",
        ...member,
        tokens: 10,
      });
      await db.execute(
        sql`UPDATE keyv_cache SET value = ${value} WHERE key LIKE 'model-pool-usage:%'`,
      );
      expect(
        (await ModelPoolUsageModel.read("pool", [member])).get(member.memberId),
      ).toBe(0);
      await ModelPoolUsageModel.record({
        poolId: "pool",
        ...member,
        tokens: 5,
      });
      expect(
        (await ModelPoolUsageModel.read("pool", [member])).get(member.memberId),
      ).toBe(5);
    }
  });
  test("sweeps expired pool counters but preserves live and unrelated rows", async () => {
    const expired = JSON.stringify({
      value: { minute: 0, tokens: 10 },
      expires: 1,
    });
    await db.execute(
      sql`INSERT INTO keyv_cache (key, value) VALUES ('model-pool-usage:removed', ${expired}), ('unrelated-counter', ${expired})`,
    );
    const member = {
      memberId: "member",
      providerApiKeyId: "connection",
      modelId: "model",
    };
    await ModelPoolUsageModel.record({ poolId: "live", ...member, tokens: 5 });
    await ModelPoolUsageModel.deleteExpired();
    const rows = await db.execute<{ key: string }>(
      sql`SELECT key FROM keyv_cache WHERE key IN ('model-pool-usage:removed', 'unrelated-counter')`,
    );
    expect(rows.rows.map((row) => row.key)).toEqual(["unrelated-counter"]);
    expect(
      (await ModelPoolUsageModel.read("live", [member])).get("member"),
    ).toBe(5);
  });
});
