import { LlmThroughput, ThroughputError } from "@/services/llm-throughput";
import { describe, expect, test } from "@/test";
import { normalizeAnthropicUsage } from "@/utils/billable-usage";
import CacheEntryModel from "./cache-entry";
import LimitModel from "./limit";
import LlmThroughputModel from "./llm-throughput";

describe("shared LLM throughput admission", () => {
  test("observes rules added and deleted after an empty lookup without leaking between entity scopes", async ({
    makeOrganization,
  }) => {
    const first = await makeOrganization();
    const other = await makeOrganization();
    const scope = (organizationId: string) => ({
      entities: [
        { entityType: "organization" as const, entityId: organizationId },
      ],
      model: "a",
    });
    await expect(LlmThroughputModel.admit(scope(first.id))).resolves.toEqual({
      reservation: null,
    });
    const rule = await LimitModel.create({
      entityType: "organization",
      entityId: first.id,
      limitType: "requests",
      cleanupInterval: "calendar_day",
      limitValue: 1,
    });
    await LlmThroughputModel.admit(scope(first.id));
    await expect(
      LlmThroughputModel.admit(scope(first.id)),
    ).resolves.toMatchObject({
      denied: { entityType: "organization", limitType: "requests" },
    });
    await expect(LlmThroughputModel.admit(scope(other.id))).resolves.toEqual({
      reservation: null,
    });
    await LimitModel.delete(rule.id);
    await expect(LlmThroughputModel.admit(scope(first.id))).resolves.toEqual({
      reservation: null,
    });
  });

  test("ignores old forecast counters and admits huge output bounds without prediction", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const token = await LimitModel.create({
      entityType: "organization",
      entityId: org.id,
      limitType: "tokens",
      cleanupInterval: "calendar_month",
      limitValue: 1,
    });
    await CacheEntryModel.withLock(`llm-throughput:${token.id}`, (entries) =>
      entries.set(
        `keyv:llm-throughput-counter-${token.id}`,
        JSON.stringify({
          value: { version: 2, count: 999999 },
          expires: Date.now() + 86400000,
        }),
      ),
    );
    const scope = {
      entities: [{ entityType: "organization" as const, entityId: org.id }],
      model: "a",
    };
    const call = new LlmThroughput(scope);
    await call.admit({
      max_tokens: 2147483647,
      messages: [{ content: "No prediction" }],
    });
    expect(
      (await LlmThroughputModel.usage([token])).get(token.id)?.currentUsage,
    ).toBe(0);
    await call.reconcile({ inputTokens: 100, outputTokens: 20 });
    expect(
      (await LlmThroughputModel.usage([token])).get(token.id)?.currentUsage,
    ).toBe(120);
    await expect(new LlmThroughput(scope).admit()).rejects.toMatchObject({
      status: 429,
      code: "archestra_quota_exceeded",
    });
  });

  test("excludes synthetic metrics and records provider output when only input is estimated", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const rule = await LimitModel.create({
      entityType: "organization",
      entityId: org.id,
      limitType: "tokens",
      cleanupInterval: "calendar_day",
      limitValue: 100,
    });
    const scope = {
      entities: [{ entityType: "organization" as const, entityId: org.id }],
      model: "a",
    };
    for (const provider of ["minimax", "microsoft-365-copilot"] as const) {
      const call = new LlmThroughput({ ...scope, provider });
      await call.admit();
      await call.reconcile({
        inputTokens: 500,
        outputTokens: 500,
        inputTokensEstimated: provider === "minimax",
        outputTokensEstimated: provider === "minimax",
      });
    }
    expect(
      (await LlmThroughputModel.usage([rule])).get(rule.id)?.currentUsage,
    ).toBe(0);
    const call = new LlmThroughput(scope);
    await call.admit();
    await call.reconcile({
      inputTokens: 500,
      outputTokens: 7,
      inputTokensEstimated: true,
    });
    expect(
      (await LlmThroughputModel.usage([rule])).get(rule.id)?.currentUsage,
    ).toBe(7);
  });

  test("failed actual-usage storage returns 503 and the rolled-back receipt can retry once", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const rule = await LimitModel.create({
      entityType: "organization",
      entityId: org.id,
      limitType: "tokens",
      cleanupInterval: "calendar_month",
      limitValue: 100,
    });
    const call = new LlmThroughput({
      entities: [{ entityType: "organization", entityId: org.id }],
      model: "a",
    });
    await call.admit();
    const key = `keyv:llm-throughput-counter-actual-tokens-v1-${rule.id}`;
    let previous = "";
    await CacheEntryModel.withLock(
      `llm-throughput:${rule.id}`,
      async (entries) => {
        const raw = await entries.get(key);
        if (!raw) throw new Error("Expected initialized token counter");
        previous = raw;
        await entries.set(key, "invalid");
      },
    );
    await expect(
      call.reconcile({ inputTokens: 10, outputTokens: 5 }),
    ).rejects.toMatchObject({
      status: 503,
      code: "archestra_quota_storage_unavailable",
    });
    await CacheEntryModel.withLock(`llm-throughput:${rule.id}`, (entries) =>
      entries.set(key, previous),
    );
    await call.reconcile({ inputTokens: 10, outputTokens: 5 });
    await call.reconcile({ inputTokens: 10, outputTokens: 5 });
    expect(
      (await LlmThroughputModel.usage([rule])).get(rule.id)?.currentUsage,
    ).toBe(15);
  });

  test("expired settlement receipts cannot charge later work", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const rule = await LimitModel.create({
      entityType: "organization",
      entityId: org.id,
      limitType: "tokens_per_minute",
      limitValue: 1000,
    });
    const result = await LlmThroughputModel.admit({
      entities: [{ entityType: "organization", entityId: org.id }],
      model: "model-a",
    });
    if (!("reservation" in result) || !result.reservation)
      throw new Error("Expected reservation");
    const reservation = result.reservation;
    const key = `keyv:llm-throughput-receipt-actual-v1-${reservation.id}`;
    await CacheEntryModel.withLocks(
      [`llm-throughput:${rule.id}`],
      async (entries) => {
        await entries.set(
          key,
          JSON.stringify({
            value: { ...reservation, expiresAt: 1 },
            expires: 1,
          }),
        );
      },
    );
    await LlmThroughputModel.reconcile({ reservation, tokens: 500 });
    expectUsage(
      (await LlmThroughputModel.usage([rule])).get(rule.id)?.currentUsage,
      0,
      1000,
    );
  });

  test("caps simultaneous calls and rolls back every child when a parent denies", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const parent = await LimitModel.create({
      entityType: "organization",
      entityId: org.id,
      limitType: "requests_per_minute",
      limitValue: 5,
    });
    const child = await LimitModel.create({
      entityType: "virtual_key",
      entityId: "synthetic-key",
      limitType: "requests_per_minute",
      limitValue: 20,
    });
    const entities = [
      { entityType: "organization" as const, entityId: org.id },
      { entityType: "virtual_key" as const, entityId: child.entityId },
    ];
    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        LlmThroughputModel.admit({ entities, model: "model-a" }),
      ),
    );
    expect(results.filter((result) => "reservation" in result)).toHaveLength(5);
    const denied = results.filter((result) => "denied" in result);
    expect(denied).toHaveLength(15);
    expect(denied[0]).toMatchObject({
      denied: { entityType: "organization", oversized: false },
    });
    const usage = await LlmThroughputModel.usage([parent, child]);
    expectUsage(usage.get(parent.id)?.currentUsage, 5, 5);
    expectUsage(usage.get(child.id)?.currentUsage, 5, 20);
  });

  test("applies aggregate and matching model rules cumulatively, without charging other models or teams", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const global = await LimitModel.create({
      entityType: "organization",
      entityId: org.id,
      limitType: "requests_per_minute",
      limitValue: 3,
    });
    const model = await LimitModel.create({
      entityType: "team",
      entityId: "team-a",
      limitType: "requests_per_minute",
      limitValue: 1,
      model: ["model-a"],
    });
    const entities = [
      { entityType: "organization" as const, entityId: org.id },
      { entityType: "team" as const, entityId: "team-a" },
    ];
    const admit = (name: string) =>
      LlmThroughputModel.admit({ entities, model: name });
    expect(await admit("model-a")).toHaveProperty("reservation");
    expect(await admit("model-a")).toHaveProperty("denied");
    expect(await admit("model-b")).toHaveProperty("reservation");
    expect(
      await LlmThroughputModel.admit({
        entities: [{ entityType: "team", entityId: "team-b" }],
        model: "model-a",
      }),
    ).toEqual({ reservation: null });
    const usage = await LlmThroughputModel.usage([global, model]);
    expectUsage(usage.get(global.id)?.currentUsage, 2, 3);
    expectUsage(usage.get(model.id)?.currentUsage, 1, 1);
  });

  test("rejects counter overflow without consuming the reporting receipt", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const rule = await LimitModel.create({
      entityType: "organization",
      entityId: org.id,
      limitType: "tokens",
      cleanupInterval: "calendar_day",
      limitValue: 1000,
    });
    const entities = [
      { entityType: "organization" as const, entityId: org.id },
    ];
    const first = await LlmThroughputModel.admit({
      entities,
      model: "model-a",
    });
    const next = await LlmThroughputModel.admit({ entities, model: "model-a" });
    if (
      !("reservation" in first) ||
      !first.reservation ||
      !("reservation" in next) ||
      !next.reservation
    )
      throw new Error("Expected reporting receipts");
    await LlmThroughputModel.reconcile({
      reservation: first.reservation,
      tokens: Number.MAX_SAFE_INTEGER,
    });
    await expect(
      LlmThroughputModel.reconcile({
        reservation: next.reservation,
        tokens: 1,
      }),
    ).rejects.toThrow("Shared quota counter overflow");
    expect(
      (await LlmThroughputModel.usage([rule])).get(rule.id)?.currentUsage,
    ).toBe(Number.MAX_SAFE_INTEGER);
    await expect(
      LlmThroughputModel.reconcile({
        reservation: next.reservation,
        tokens: 1,
      }),
    ).rejects.toThrow("Shared quota counter overflow");
    await LlmThroughputModel.reconcile({
      reservation: next.reservation,
      tokens: 0,
    });
    expect(
      (await LlmThroughputModel.usage([rule])).get(rule.id)?.currentUsage,
    ).toBe(Number.MAX_SAFE_INTEGER);
  });

  test("admits concurrent calls before reports, adds actual debt once, then blocks", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const rule = await LimitModel.create({
      entityType: "organization",
      entityId: org.id,
      limitType: "tokens_per_minute",
      limitValue: 1000,
    });
    const entities = [
      { entityType: "organization" as const, entityId: org.id },
    ];
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        LlmThroughputModel.admit({ entities, model: "model-a" }),
      ),
    );
    expect(results.filter((result) => "reservation" in result)).toHaveLength(5);
    expect(
      (await LlmThroughputModel.usage([rule])).get(rule.id)?.currentUsage,
    ).toBe(0);
    const result = results.find((result) => "reservation" in result);
    if (!result || !("reservation" in result) || !result.reservation)
      throw new Error("Expected reservation");
    const reservation = result.reservation;
    await Promise.all(
      Array.from({ length: 5 }, () =>
        LlmThroughputModel.reconcile({
          reservation,
          tokens: 900,
        }),
      ),
    );
    expectUsage(
      (await LlmThroughputModel.usage([rule])).get(rule.id)?.currentUsage,
      900,
      1000,
    );
    const next = await LlmThroughputModel.admit({
      entities,
      model: "model-a",
    });
    if (!("reservation" in next) || !next.reservation)
      throw new Error("Expected next reservation");
    await LlmThroughputModel.reconcile({
      reservation: next.reservation,
      tokens: 600,
    });
    expectUsage(
      (await LlmThroughputModel.usage([rule])).get(rule.id)?.currentUsage,
      1500,
      1000,
    );
    expect(
      await LlmThroughputModel.admit({
        entities,
        model: "model-a",
      }),
    ).toMatchObject({
      denied: { oversized: false, retryAfter: expect.any(Number) },
    });
  });

  test("releases both dimensions once when canceled before upstream send", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const rules = await Promise.all(
      (["requests_per_minute", "tokens_per_minute"] as const).map((limitType) =>
        LimitModel.create({
          entityType: "organization",
          entityId: org.id,
          limitType,
          limitValue: limitType === "requests_per_minute" ? 1 : 5000,
        }),
      ),
    );
    const call = new LlmThroughput({
      entities: [{ entityType: "organization", entityId: org.id }],
      model: "model-a",
    });
    await call.admit({});
    await Promise.all([call.cancelBeforeSend(), call.cancelBeforeSend()]);
    await call.reconcile({ inputTokens: 20, outputTokens: 10 });
    const usage = await LlmThroughputModel.usage(rules);
    expect(rules.map((rule) => usage.get(rule.id)?.currentUsage)).toEqual([
      0, 0,
    ]);
  });

  test("missing and zero usage charge nothing; partial reports count known tokens and retries admit once", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const rpm = await LimitModel.create({
      entityType: "organization",
      entityId: org.id,
      limitType: "requests_per_minute",
      limitValue: 5,
    });
    const tpm = await LimitModel.create({
      entityType: "organization",
      entityId: org.id,
      limitType: "tokens_per_minute",
      limitValue: 10000,
    });
    const call = new LlmThroughput({
      entities: [{ entityType: "organization", entityId: org.id }],
      model: "model-a",
    });
    await call.admit({ max_tokens: 100 });
    await call.admit({ max_tokens: 100 });
    await call.reconcile(undefined);
    await call.reconcile({ inputTokens: 0, outputTokens: 0 });
    expectUsage(
      (await LlmThroughputModel.usage([tpm])).get(tpm.id)?.currentUsage,
      0,
      10000,
    );
    const partial = new LlmThroughput({
      entities: [{ entityType: "organization", entityId: org.id }],
      model: "model-a",
    });
    await partial.admit({ max_tokens: 2147483647 });
    await partial.reconcile({ inputTokens: 5, outputTokens: 1 });
    await partial.reconcile({ inputTokens: 5, outputTokens: 1 });
    const usage = await LlmThroughputModel.usage([rpm, tpm]);
    expectUsage(usage.get(rpm.id)?.currentUsage, 2, 5);
    expectUsage(usage.get(tpm.id)?.currentUsage, 6, 10000);
  });

  test("counts disjoint normalized cache usage once, including the 1h write subset", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const rule = await LimitModel.create({
      entityType: "organization",
      entityId: org.id,
      limitType: "tokens_per_minute",
      limitValue: 10000,
    });
    const call = new LlmThroughput({
      entities: [{ entityType: "organization", entityId: org.id }],
      model: "model-a",
    });
    await call.admit({});
    const usage = normalizeAnthropicUsage(
      {
        input_tokens: 100,
        output_tokens: 20,
        cache_read_input_tokens: 200,
        cache_creation_input_tokens: 300,
        cache_creation: {
          ephemeral_5m_input_tokens: 200,
          ephemeral_1h_input_tokens: 100,
        },
      },
      "model-a",
    );
    expect(usage).toMatchObject({
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 200,
      cacheWriteTokens: 300,
      cacheWrite1hTokens: 100,
    });
    await call.reconcile(usage);
    expectUsage(
      (await LlmThroughputModel.usage([rule])).get(rule.id)?.currentUsage,
      620,
      10000,
    );
  });

  test("counts additional Gemini thoughts and complete provider iterations without duplicating primary totals", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const rule = await LimitModel.create({
      entityType: "organization",
      entityId: org.id,
      limitType: "tokens_per_minute",
      limitValue: 10000,
    });
    const scope = {
      entities: [{ entityType: "organization" as const, entityId: org.id }],
      model: "model-a",
    };
    const gemini = new LlmThroughput({ ...scope, provider: "gemini" });
    await gemini.admit({ max_tokens: 100 });
    await gemini.reconcile({
      inputTokens: 20,
      outputTokens: 10,
      reasoningTokens: 30,
      cacheReadTokens: 40,
    });
    expectUsage(
      (await LlmThroughputModel.usage([rule])).get(rule.id)?.currentUsage,
      100,
      10000,
    );
    const anthropic = new LlmThroughput({ ...scope, provider: "anthropic" });
    await anthropic.admit({ max_tokens: 100 });
    await anthropic.reconcile(
      normalizeAnthropicUsage(
        {
          input_tokens: 100,
          output_tokens: 20,
          iterations: [
            { type: "message", input_tokens: 100, output_tokens: 20 },
            {
              type: "advisor_message",
              model: "model-b",
              input_tokens: 200,
              output_tokens: 30,
            },
          ],
        },
        "model-a",
      ),
    );
    expectUsage(
      (await LlmThroughputModel.usage([rule])).get(rule.id)?.currentUsage,
      450,
      10000,
    );
  });

  test("excludes estimated dimensions and fails closed on malformed shared state", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const rule = await LimitModel.create({
      entityType: "organization",
      entityId: org.id,
      limitType: "tokens_per_minute",
      limitValue: 10000,
    });
    const scope = {
      entities: [{ entityType: "organization" as const, entityId: org.id }],
      model: "a",
    };
    const call = new LlmThroughput(scope);
    await call.admit({});
    await call.reconcile({
      inputTokens: 10,
      outputTokens: 5,
      inputTokensEstimated: true,
    });
    expectUsage(
      (await LlmThroughputModel.usage([rule])).get(rule.id)?.currentUsage,
      5,
      10000,
    );
    await CacheEntryModel.withLock(`llm-throughput:${rule.id}`, (entries) =>
      entries.set(
        `keyv:llm-throughput-counter-actual-tokens-v1-${rule.id}`,
        '{"value":{"window":0,"count":null}}',
      ),
    );
    await expect(new LlmThroughput(scope).admit({})).rejects.toMatchObject({
      status: 503,
      code: "archestra_quota_storage_unavailable",
    });
  });

  test("has a no-quota fast path and validates updates against the complete rule", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    expect(
      await LlmThroughputModel.admit({
        entities: [{ entityType: "organization", entityId: org.id }],
        model: "a",
      }),
    ).toEqual({ reservation: null });
    const rule = await LimitModel.create({
      entityType: "organization",
      entityId: org.id,
      limitType: "requests_per_minute",
      limitValue: 1,
    });
    await expect(LimitModel.patch(rule.id, { limitValue: -1 })).rejects.toThrow(
      "Invalid limit configuration",
    );
    await expect(
      LimitModel.patch(rule.id, { cleanupInterval: "1m" }),
    ).rejects.toThrow("Invalid limit configuration");
    await expect(
      LimitModel.create({
        entityType: "user",
        entityId: "synthetic",
        limitType: "tokens_per_minute",
        limitValue: 100,
      }),
    ).rejects.toThrow();
    const call = new LlmThroughput({
      entities: [{ entityType: "organization", entityId: org.id }],
      model: "a",
    });
    await call.admit({});
    const denied = new LlmThroughput({
      entities: [{ entityType: "organization", entityId: org.id }],
      model: "a",
    });
    await expect(denied.admit({})).rejects.toBeInstanceOf(ThroughputError);
  });
});

// Storage tests use the real database clock; precise elapsed-time arithmetic
// is pinned separately. This permits up to 1.2 seconds of actual test runtime.
function expectUsage(
  actual: number | undefined,
  expected: number,
  capacity: number,
) {
  expect(actual).toBeDefined();
  expect(actual).toBeLessThanOrEqual(expected);
  expect(actual).toBeGreaterThanOrEqual(
    Math.max(0, expected - capacity * 0.02),
  );
}
