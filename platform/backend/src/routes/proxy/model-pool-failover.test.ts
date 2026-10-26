import config from "@/config";
import { ModelPoolModel } from "@/models";
import { beforeEach, describe, expect, test } from "@/test";
import { setupTestCacheManager } from "@/test/cache-manager";
import {
  type ModelPoolCaller,
  type ModelPoolPlan,
  openThroughModelPool,
  orderPoolMembers,
  type PlannedMember,
  planModelPool,
  type UpstreamAttempt,
  withMemberHealth,
} from "./model-pool-failover";
import type { MemberTransport } from "./model-pool-transport";

// Model pools are a beta feature; these tests run with it on.
beforeEach(() => {
  config.llmProxy.modelPoolsEnabled = true;
});

setupTestCacheManager();

describe("orderPoolMembers", () => {
  const member = (id: string, priority: number, weight = 1) => ({
    id,
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

  test("AC-W1: weights 1:2:7 split first picks within the lab's bounds", () => {
    const counts = { a: 0, b: 0, c: 0 };
    const draws = 2000;
    for (let i = 0; i < draws; i++) {
      const [first] = orderPoolMembers({
        members: [member("a", 1, 1), member("b", 1, 2), member("c", 1, 7)],
        benchedUntil: new Map(),
        seed: `session-${i}`,
      });
      counts[first as keyof typeof counts]++;
    }
    const expected = { a: 0.1, b: 0.2, c: 0.7 };
    let chiSquare = 0;
    for (const id of ["a", "b", "c"] as const) {
      const want = expected[id] * draws;
      chiSquare += (counts[id] - want) ** 2 / want;
      expect(Math.abs(counts[id] / draws - expected[id])).toBeLessThan(0.05);
    }
    // df = 2, p = 0.01
    expect(chiSquare).toBeLessThan(9.21);
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
  test("plans every member of the pool with that name, across providers", async ({
    makeOrganization,
    makeLlmProviderApiKey,
  }) => {
    const org = await makeOrganization();
    const zai = await makeLlmProviderApiKey(org.id, null, {
      provider: "zhipuai",
    });
    const bedrock = await makeLlmProviderApiKey(org.id, null, {
      provider: "bedrock",
    });
    const pool = await ModelPoolModel.create({
      organizationId: org.id,
      input: {
        name: "glm-5",
        members: [
          member(zai.id, "glm-5", 1),
          member(bedrock.id, "zai.glm-5", 2),
        ],
        virtualApiKeyIds: [],
      },
    });

    const plan = await planModelPool({
      organizationId: org.id,
      name: "glm-5",
      inbound: "openai-chat",
      caller: { providerApiKeyIds: [zai.id] },
    });
    expect(plan).toEqual({
      poolId: pool.id,
      poolName: "glm-5",
      members: [
        expect.objectContaining({
          providerApiKeyId: zai.id,
          provider: "zhipuai",
          modelId: "glm-5",
        }),
        expect.objectContaining({
          providerApiKeyId: bedrock.id,
          provider: "bedrock",
          modelId: "zai.glm-5",
        }),
      ],
    });
    await expect(
      planModelPool({
        organizationId: org.id,
        name: "glm-4.6",
        inbound: "openai-chat",
        caller: { providerApiKeyIds: [zai.id] },
      }),
    ).resolves.toBeNull();
  });

  test("plans nothing while model pools are off", async ({
    makeOrganization,
    makeLlmProviderApiKey,
  }) => {
    const org = await makeOrganization();
    const zai = await makeLlmProviderApiKey(org.id, null, {
      provider: "zhipuai",
    });
    await ModelPoolModel.create({
      organizationId: org.id,
      input: {
        name: "glm-5",
        members: [member(zai.id, "glm-5", 1)],
        virtualApiKeyIds: [],
      },
    });

    config.llmProxy.modelPoolsEnabled = false;
    await expect(
      planModelPool({
        organizationId: org.id,
        name: "glm-5",
        inbound: "openai-chat",
        caller: { providerApiKeyIds: [zai.id] },
      }),
    ).resolves.toBeNull();
  });

  test("leaves out members the client's wire cannot reach", async ({
    makeOrganization,
    makeLlmProviderApiKey,
  }) => {
    const org = await makeOrganization();
    const zai = await makeLlmProviderApiKey(org.id, null, {
      provider: "zhipuai",
    });
    const bedrock = await makeLlmProviderApiKey(org.id, null, {
      provider: "bedrock",
    });
    await ModelPoolModel.create({
      organizationId: org.id,
      input: {
        name: "glm-5",
        members: [
          member(zai.id, "glm-5", 1),
          member(bedrock.id, "zai.glm-5", 1),
        ],
        virtualApiKeyIds: [],
      },
    });

    // Anthropic's wire reaches OpenAI-style members, not Converse ones.
    const plan = await planModelPool({
      organizationId: org.id,
      name: "glm-5",
      inbound: "anthropic",
      caller: { providerApiKeyIds: [zai.id] },
    });
    expect(plan?.members.map((m) => m.providerApiKeyId)).toEqual([zai.id]);
    // Converse reaches only Converse members.
    const conversePlan = await planModelPool({
      organizationId: org.id,
      name: "glm-5",
      inbound: "bedrock-converse",
      caller: { providerApiKeyIds: [zai.id] },
    });
    expect(conversePlan?.members.map((m) => m.providerApiKeyId)).toEqual([
      bedrock.id,
    ]);
  });

  test("plans the pool only for callers that may use it", async ({
    makeOrganization,
    makeLlmProviderApiKey,
    makeVirtualApiKey,
  }) => {
    const org = await makeOrganization();
    const zai = await makeLlmProviderApiKey(org.id, null, {
      provider: "zhipuai",
    });
    const openai = await makeLlmProviderApiKey(org.id, null);
    const granted = await makeVirtualApiKey(org.id, {
      providerApiKeys: [{ provider: "openai", providerApiKeyId: openai.id }],
    });
    const mapsMember = await makeVirtualApiKey(org.id, {
      providerApiKeys: [{ provider: "zhipuai", providerApiKeyId: zai.id }],
    });
    const neither = await makeVirtualApiKey(org.id, {
      providerApiKeys: [{ provider: "openai", providerApiKeyId: openai.id }],
    });
    const pool = await ModelPoolModel.create({
      organizationId: org.id,
      input: {
        name: "glm-5",
        members: [member(zai.id, "glm-5", 1)],
        virtualApiKeyIds: [granted.id],
      },
    });
    const plan = (caller: ModelPoolCaller, grantedPoolId?: string) =>
      planModelPool({
        organizationId: org.id,
        name: "glm-5",
        inbound: "openai-chat",
        caller,
        grantedPoolId,
      });

    // A virtual key gets in by a grant, or by mapping a member's key, as a
    // Connect key does.
    expect(
      await plan({ virtualKeyId: granted.id, providerApiKeyIds: [openai.id] }),
    ).not.toBeNull();
    expect(
      await plan({ virtualKeyId: mapsMember.id, providerApiKeyIds: [zai.id] }),
    ).not.toBeNull();
    expect(
      await plan({ virtualKeyId: neither.id, providerApiKeyIds: [openai.id] }),
    ).toBeNull();
    // Any other caller must already use a member's key.
    expect(await plan({ providerApiKeyIds: [zai.id] })).not.toBeNull();
    expect(await plan({ providerApiKeyIds: [openai.id] })).toBeNull();
    expect(await plan({ providerApiKeyIds: [] })).toBeNull();
    // The Model Router passes on a pool it already let the caller use.
    expect(await plan({ providerApiKeyIds: [] }, pool.id)).not.toBeNull();
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
        name: "claude-haiku-4-5",
        members: [
          member(first.id, "claude-haiku-4-5", 1),
          member(second.id, "claude-haiku-4-5", 2),
        ],
        virtualApiKeyIds: [],
      },
    });
    const planParams = {
      organizationId: org.id,
      name: "claude-haiku-4-5",
      inbound: "anthropic" as const,
      caller: { providerApiKeyIds: [first.id] },
    };
    const plan = (await planModelPool(planParams)) as ModelPoolPlan;

    await openThroughModelPool({
      plan,
      attempt: {},
      transportFor: async (m) => transport(m.providerApiKeyId),
      open: async (t) => {
        const answer = await t.execute({});
        if (answer === first.id) throw httpError(429, { "retry-after": "20" });
        return "ok";
      },
      isRetryable: () => false,
      shouldContinue: () => true,
      recordFailedAttempt: async () => {},
    });

    expect(
      (await planModelPool(planParams))?.members.map((m) => m.providerApiKeyId),
    ).toEqual([second.id, first.id]);
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
  const keyA = "00000000-0000-4000-8000-00000000000a";
  const keyB = "00000000-0000-4000-8000-00000000000b";
  const plan: ModelPoolPlan = {
    poolId: "00000000-0000-4000-8000-000000000001",
    poolName: "glm-5",
    members: [
      {
        memberId: "00000000-0000-4000-8000-0000000000a1",
        providerApiKeyId: keyA,
        provider: "zhipuai",
        modelId: "glm-5",
      },
      {
        memberId: "00000000-0000-4000-8000-0000000000b1",
        providerApiKeyId: keyB,
        provider: "bedrock",
        modelId: "zai.glm-5",
      },
    ],
  };
  const openKey = (fail: (key: string) => Error | null) => ({
    transportFor: async (m: PlannedMember) => transport(m.providerApiKeyId),
    open: async (t: MemberTransport) => {
      const key = (await t.execute({})) as string;
      const error = fail(key);
      if (error) throw error;
      return `answer from ${key}`;
    },
  });

  test("fails over before the first chunk and records the failed attempt", async () => {
    const attempt: UpstreamAttempt = {};
    const recorded: UpstreamAttempt[] = [];

    const result = await openThroughModelPool({
      plan,
      attempt,
      ...openKey((key) => (key === keyA ? httpError(529) : null)),
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
        provider: "zhipuai",
        modelId: "glm-5",
        attempt: 1,
        attemptOutcome: "failed_over",
        failureReason: "server_error (529)",
      },
    ]);
    expect(attempt).toEqual({
      modelPoolId: plan.poolId,
      providerApiKeyId: keyB,
      provider: "bedrock",
      modelId: "zai.glm-5",
      attempt: 2,
      attemptOutcome: "answered",
      failureReason: undefined,
      // Its row's duration starts here, not when the request arrived.
      startedAt: expect.any(Number),
    });
  });

  test("fails over on a rejected member credential", async () => {
    const attempt: UpstreamAttempt = {};
    await openThroughModelPool({
      plan,
      attempt,
      ...openKey((key) => (key === keyA ? httpError(401) : null)),
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
        ...openKey((key) => {
          opened.push(key);
          return badRequest;
        }),
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
      failureReason: "error",
    });
  });

  test("moves past a member that sends nothing in time, and aborts its call", async () => {
    const attempt: UpstreamAttempt = {};
    const recorded: UpstreamAttempt[] = [];
    const signals = new Map<string, AbortSignal>();

    const result = await openThroughModelPool({
      plan,
      attempt,
      transportFor: async (m, signal) => {
        signals.set(m.providerApiKeyId, signal);
        return transport(m.providerApiKeyId);
      },
      open: async (t) => {
        const key = (await t.execute({})) as string;
        if (key === keyA) await new Promise(() => {});
        return `answer from ${key}`;
      },
      memberTimeoutMs: 20,
      isRetryable: () => false,
      shouldContinue: () => true,
      recordFailedAttempt: async (failed) => {
        recorded.push(failed);
      },
    });

    expect(result).toBe(`answer from ${keyB}`);
    expect(recorded).toMatchObject([
      { providerApiKeyId: keyA, failureReason: "timeout (408)" },
    ]);
    expect(signals.get(keyA)?.aborted).toBe(true);
    expect(signals.get(keyB)?.aborted).toBe(false);
  });

  test("moves past a member whose key can't be loaded", async () => {
    const attempt: UpstreamAttempt = {};
    const recorded: UpstreamAttempt[] = [];
    const vaultDown = new Error("secret store unreachable");

    const result = await openThroughModelPool({
      plan,
      attempt,
      transportFor: async (m) => {
        if (m.providerApiKeyId === keyA) throw vaultDown;
        return transport(m.providerApiKeyId);
      },
      open: async (t) => `answer from ${await t.execute({})}`,
      isRetryable: () => false,
      shouldContinue: () => true,
      recordFailedAttempt: async (failed) => {
        recorded.push(failed);
      },
    });

    expect(result).toBe(`answer from ${keyB}`);
    expect(recorded).toMatchObject([
      { providerApiKeyId: keyA, failureReason: "key_unavailable" },
    ]);
    // On the last member there is nowhere to go: its own error is returned.
    await expect(
      openThroughModelPool({
        plan: { ...plan, members: [plan.members[0]] },
        attempt: {},
        transportFor: async () => {
          throw vaultDown;
        },
        open: async () => "unreachable",
        isRetryable: () => false,
        shouldContinue: () => true,
        recordFailedAttempt: async () => {},
      }),
    ).rejects.toBe(vaultDown);
  });

  test("waits on the last member however slow, and retries only that one", async () => {
    const attempt: UpstreamAttempt = {};
    const opened: string[] = [];
    const dropped = Object.assign(new Error("socket hang up"), {
      code: "ECONNRESET",
    });

    const result = await openThroughModelPool({
      plan,
      attempt,
      ...openKey(() => null),
      open: async (t) => {
        const key = (await t.execute({})) as string;
        opened.push(key);
        if (key === keyA) throw httpError(503);
        if (opened.filter((k) => k === keyB).length === 1) throw dropped;
        await new Promise((resolve) => setTimeout(resolve, 40));
        return `answer from ${key}`;
      },
      memberTimeoutMs: 20,
      isRetryable: (error) => error === dropped,
      shouldContinue: () => true,
      recordFailedAttempt: async () => {},
    });

    expect(result).toBe(`answer from ${keyB}`);
    expect(opened).toEqual([keyA, keyB, keyB]);
  });

  test("does not retry a member's dropped connection while a sibling is left", async () => {
    const attempt: UpstreamAttempt = {};
    const opened: string[] = [];
    const dropped = Object.assign(new Error("socket hang up"), {
      code: "ECONNRESET",
    });

    await openThroughModelPool({
      plan,
      attempt,
      ...openKey(() => null),
      open: async (t) => {
        const key = (await t.execute({})) as string;
        opened.push(key);
        if (key === keyA) throw dropped;
        return `answer from ${key}`;
      },
      isRetryable: (error) => error === dropped,
      shouldContinue: () => true,
      recordFailedAttempt: async () => {},
    });

    expect(opened).toEqual([keyA, keyB]);
    expect(attempt.providerApiKeyId).toBe(keyB);
  });

  test("returns the last member's failure when every member fails", async () => {
    const attempt: UpstreamAttempt = {};
    const lastError = httpError(429);

    await expect(
      openThroughModelPool({
        plan,
        attempt,
        ...openKey((key) => (key === keyB ? lastError : httpError(503))),
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

function member(providerApiKeyId: string, modelId: string, priority: number) {
  return { providerApiKeyId, modelId, priority, weight: 1, enabled: true };
}

/** A transport that answers with its member's key, so tests can tell them apart. */
function transport(key: string): MemberTransport {
  return {
    execute: async () => key,
    executeStream: async () => [][Symbol.iterator]() as never,
  };
}

function httpError(status: number, headers: Record<string, string> = {}) {
  return Object.assign(new Error(`HTTP ${status}`), {
    status,
    headers: new Headers(headers),
  });
}
