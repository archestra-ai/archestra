import { ModelPoolModel } from "@/models";
import { describe, expect, test } from "@/test";
import { setupTestCacheManager } from "@/test/cache-manager";
import {
  type ModelPoolPlan,
  openThroughModelPool,
  orderPoolMembers,
  planModelPool,
  type UpstreamAttempt,
  withMemberHealth,
} from "./model-pool-failover";

setupTestCacheManager();

describe("orderPoolMembers", () => {
  const member = (id: string, priority: number, weight = 1) => ({
    providerApiKeyId: id,
    priority,
    weight,
  });

  test("tries lower priorities first", () => {
    expect(
      orderPoolMembers({
        members: [member("b", 2), member("a", 1), member("c", 3)],
        benchedUntil: new Map(),
      }),
    ).toEqual(["a", "b", "c"]);
  });

  test("splits one priority by weight", () => {
    const firsts = { heavy: 0, light: 0 };
    for (let i = 0; i < 2000; i++) {
      const [first] = orderPoolMembers({
        members: [member("heavy", 1, 9), member("light", 1, 1)],
        benchedUntil: new Map(),
        seed: `session-${i}`,
      });
      firsts[first as keyof typeof firsts]++;
    }
    expect(firsts.heavy / 2000).toBeGreaterThan(0.85);
    expect(firsts.light).toBeGreaterThan(0);
  });

  test("keeps one session on one member", () => {
    const members = [member("a", 1), member("b", 1), member("c", 1)];
    const first = orderPoolMembers({
      members,
      benchedUntil: new Map(),
      seed: "s1",
    });
    for (let i = 0; i < 5; i++) {
      expect(
        orderPoolMembers({ members, benchedUntil: new Map(), seed: "s1" }),
      ).toEqual(first);
    }
  });

  test("puts benched members last, soonest back first", () => {
    expect(
      orderPoolMembers({
        members: [member("a", 1), member("b", 1), member("c", 2)],
        benchedUntil: new Map([
          ["a", 2000],
          ["b", 1000],
        ]),
      }),
    ).toEqual(["c", "b", "a"]);
  });
});

describe("planModelPool", () => {
  test("plans only for a member key and the pool's model", async ({
    makeOrganization,
    makeLlmProviderApiKey,
  }) => {
    const org = await makeOrganization();
    const primary = await makeLlmProviderApiKey(org.id, null);
    const backup = await makeLlmProviderApiKey(org.id, null);
    const outsider = await makeLlmProviderApiKey(org.id, null);
    const pool = await ModelPoolModel.create({
      organizationId: org.id,
      input: {
        name: "haiku",
        provider: "anthropic",
        modelId: "claude-haiku-4-5",
        members: [
          {
            providerApiKeyId: primary.id,
            priority: 1,
            weight: 1,
            enabled: true,
          },
          {
            providerApiKeyId: backup.id,
            priority: 2,
            weight: 1,
            enabled: true,
          },
        ],
      },
    });

    const plan = await planModelPool({
      organizationId: org.id,
      provider: "anthropic",
      modelId: "claude-haiku-4-5",
      providerApiKeyId: backup.id,
    });
    expect(plan).toEqual({
      poolId: pool.id,
      poolName: "haiku",
      memberKeyIds: [primary.id, backup.id],
    });
    await expect(
      planModelPool({
        organizationId: org.id,
        provider: "anthropic",
        modelId: "claude-haiku-4-5",
        providerApiKeyId: outsider.id,
      }),
    ).resolves.toBeNull();
    await expect(
      planModelPool({
        organizationId: org.id,
        provider: "anthropic",
        modelId: "claude-opus-4-8",
        providerApiKeyId: primary.id,
      }),
    ).resolves.toBeNull();
  });

  test("moves a member that failed over behind the healthy ones", async ({
    makeOrganization,
    makeLlmProviderApiKey,
  }) => {
    const org = await makeOrganization();
    const first = await makeLlmProviderApiKey(org.id, null);
    const second = await makeLlmProviderApiKey(org.id, null);
    await ModelPoolModel.create({
      organizationId: org.id,
      input: {
        name: "haiku",
        provider: "anthropic",
        modelId: "claude-haiku-4-5",
        members: [
          { providerApiKeyId: first.id, priority: 1, weight: 1, enabled: true },
          {
            providerApiKeyId: second.id,
            priority: 2,
            weight: 1,
            enabled: true,
          },
        ],
      },
    });
    const planParams = {
      organizationId: org.id,
      provider: "anthropic" as const,
      modelId: "claude-haiku-4-5",
      providerApiKeyId: first.id,
    };
    const plan = (await planModelPool(planParams)) as ModelPoolPlan;

    await openThroughModelPool({
      plan,
      attempt: {},
      clientFor: async (id) => id,
      open: async (client) => {
        if (client === first.id) throw httpError(429, { "retry-after": "20" });
        return "ok";
      },
      isRetryable: () => false,
      shouldContinue: () => true,
      recordFailedAttempt: async () => {},
    });

    expect((await planModelPool(planParams))?.memberKeyIds).toEqual([
      second.id,
      first.id,
    ]);
    const [health] = await withMemberHealth(await ModelPoolModel.list(org.id));
    expect(health.members).toEqual([
      expect.objectContaining({
        providerApiKeyId: first.id,
        benchedUntil: expect.any(String),
        benchReason: "rate_limited (429)",
      }),
      expect.objectContaining({
        providerApiKeyId: second.id,
        benchedUntil: null,
        benchReason: null,
      }),
    ]);
  });
});

describe("openThroughModelPool", () => {
  const plan: ModelPoolPlan = {
    poolId: "00000000-0000-4000-8000-000000000001",
    poolName: "haiku",
    memberKeyIds: [
      "00000000-0000-4000-8000-00000000000a",
      "00000000-0000-4000-8000-00000000000b",
    ],
  };
  const [keyA, keyB] = plan.memberKeyIds;

  test("fails over before the first chunk and records the failed attempt", async () => {
    const attempt: UpstreamAttempt = {};
    const recorded: UpstreamAttempt[] = [];

    const result = await openThroughModelPool({
      plan,
      attempt,
      clientFor: async (id) => id,
      open: async (client) => {
        if (client === keyA) throw httpError(529);
        return `answer from ${client}`;
      },
      isRetryable: () => false,
      shouldContinue: () => true,
      recordFailedAttempt: async (failed) => {
        recorded.push(failed);
      },
    });

    expect(result).toBe(`answer from ${keyB}`);
    expect(recorded).toEqual([
      {
        modelPoolId: plan.poolId,
        providerApiKeyId: keyA,
        attempt: 1,
        attemptOutcome: "failed_over",
        failureReason: "server_error (529)",
      },
    ]);
    expect(attempt).toEqual({
      modelPoolId: plan.poolId,
      providerApiKeyId: keyB,
      attempt: 2,
      attemptOutcome: "answered",
      failureReason: undefined,
    });
  });

  test("fails over on a rejected member credential", async () => {
    const attempt: UpstreamAttempt = {};
    await openThroughModelPool({
      plan,
      attempt,
      clientFor: async (id) => id,
      open: async (client) => {
        if (client === keyA) throw httpError(401);
        return "ok";
      },
      isRetryable: () => false,
      shouldContinue: () => true,
      recordFailedAttempt: async () => {},
    });
    expect(attempt.providerApiKeyId).toBe(keyB);
  });

  test("returns a bad request as is, on the first member", async () => {
    const attempt: UpstreamAttempt = {};
    const opened: string[] = [];
    const badRequest = httpError(400);

    await expect(
      openThroughModelPool({
        plan,
        attempt,
        clientFor: async (id) => id,
        open: async (client) => {
          opened.push(client);
          throw badRequest;
        },
        isRetryable: () => false,
        shouldContinue: () => true,
        recordFailedAttempt: async () => {},
      }),
    ).rejects.toBe(badRequest);
    expect(opened).toEqual([keyA]);
    expect(attempt).toMatchObject({
      providerApiKeyId: keyA,
      attempt: 1,
      attemptOutcome: "failed",
    });
  });

  test("returns the last member's failure when every member fails", async () => {
    const attempt: UpstreamAttempt = {};
    const lastError = httpError(429);

    await expect(
      openThroughModelPool({
        plan,
        attempt,
        clientFor: async (id) => id,
        open: async (client) => {
          throw client === keyB ? lastError : httpError(503);
        },
        isRetryable: () => false,
        shouldContinue: () => true,
        recordFailedAttempt: async () => {},
      }),
    ).rejects.toBe(lastError);
    expect(attempt).toMatchObject({
      providerApiKeyId: keyB,
      attempt: 2,
      attemptOutcome: "failed",
      failureReason: "rate_limited (429)",
    });
  });
});

function httpError(status: number, headers: Record<string, string> = {}) {
  return Object.assign(new Error(`HTTP ${status}`), {
    status,
    headers: new Headers(headers),
  });
}
