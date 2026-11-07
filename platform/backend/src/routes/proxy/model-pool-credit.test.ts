import { APIError as AnthropicAPIError } from "@anthropic-ai/sdk";
import { APIError as OpenAIAPIError } from "openai";
import { vi } from "vitest";
import config from "@/config";
import ModelPoolModel from "@/models/model-pool";
import { expect, test } from "@/test";
import { setupTestCacheManager } from "@/test/cache-manager";
import { ApiError } from "@/types/api";
import { poolFailoverReason } from "./llm-proxy-helpers";
import {
  type ModelPoolPlan,
  openThroughModelPool,
  planModelPool,
  withMemberHealth,
} from "./model-pool-failover";
import type { MemberTransport } from "./model-pool-transport";

setupTestCacheManager();
const credit = (status: number, payload: Record<string, unknown>) =>
  new OpenAIAPIError(status, payload, undefined, new Headers());
const insufficient = () =>
  credit(429, { code: "insufficient_quota", message: "Quota exhausted" });
const anthropicCredit = () =>
  new AnthropicAPIError(
    400,
    {
      type: "error",
      error: {
        type: "invalid_request_error",
        message:
          "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.",
      },
    },
    undefined,
    new Headers(),
  );

test("classifies provider credit refusals without broad 400 or rate-limit matches", () => {
  expect(poolFailoverReason(credit(402, {}), "openai")?.reason).toBe(
    "credit_exhausted (402)",
  );
  expect(poolFailoverReason(insufficient(), "openai")?.reason).toBe(
    "credit_exhausted (429)",
  );
  expect(
    poolFailoverReason(credit(429, { type: "insufficient_quota" }), "openai")
      ?.reason,
  ).toBe("credit_exhausted (429)");
  expect(poolFailoverReason(anthropicCredit(), "anthropic")?.reason).toBe(
    "credit_exhausted (400)",
  );
  expect(poolFailoverReason(anthropicCredit(), "openai")).toBeUndefined();
  expect(
    poolFailoverReason(
      credit(400, { message: "invalid messages" }),
      "anthropic",
    ),
  ).toBeUndefined();
  expect(
    poolFailoverReason(
      credit(400, {
        message: 'invalid tool content "Your credit balance is too low"',
      }),
      "anthropic",
    ),
  ).toBeUndefined();
  expect(
    poolFailoverReason(credit(429, { code: "rate_limit_exceeded" }), "openai")
      ?.reason,
  ).toBe("rate_limited (429)");
  expect(
    poolFailoverReason(
      new ApiError(402, "organization budget exhausted"),
      "openai",
    ),
  ).toBeUndefined();
});

for (const cooldownSeconds of [undefined, 120]) {
  test(`credit cooldown ${cooldownSeconds} excludes all-depleted pools and permits recovery`, async ({
    makeOrganization,
    makeLlmProviderApiKey,
  }) => {
    config.llmProxy.modelPoolsEnabled = true;
    const org = await makeOrganization();
    const key = await makeLlmProviderApiKey(org.id, null, {
      provider: "openai",
    });
    const pool = await ModelPoolModel.create({
      organizationId: org.id,
      input: {
        name: "credit-pool",
        cooldownSeconds,
        members: ["primary", "backup"].map((modelId, priority) => ({
          providerApiKeyId: key.id,
          modelId,
          priority,
          weight: 1,
          enabled: true,
        })),
      },
    });
    const params = {
      organizationId: org.id,
      name: pool.name,
      inbound: "openai-chat" as const,
      caller: { providerApiKeyIds: [key.id] },
    };
    const plan = (await planModelPool(params)) as ModelPoolPlan;
    const hits: string[] = [];
    let allDepleted = false;
    let recovered = false;
    let releaseTransient = () => {};
    let markStarted = () => {};
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const finishTransient = new Promise<void>((resolve) => {
      releaseTransient = resolve;
    });
    const run = async (savedPlan?: ModelPoolPlan, delayedTransient = false) =>
      openThroughModelPool({
        plan: savedPlan ?? ((await planModelPool(params)) as ModelPoolPlan),
        attempt: {},
        transportFor: async (member) =>
          ({
            executeStream: async () => (async function* () {})(),
            execute: async () => {
              hits.push(member.modelId);
              if (delayedTransient && member.modelId === "primary") {
                markStarted();
                await finishTransient;
                throw credit(429, { code: "rate_limit_exceeded" });
              }
              if (!recovered && (member.modelId === "primary" || allDepleted))
                throw insufficient();
              return "answered";
            },
          }) as MemberTransport,
        open: (transport) => transport.execute({}),
        isRetryable: () => false,
        shouldContinue: () => true,
        prepareFailedAttempt: async () => async () => {},
      });
    // A request already in flight must not undo a later credit exclusion.
    const lateTransient = run(plan, true);
    await started;
    hits.length = 0;
    const now = Date.now();
    expect(await run()).toBe("answered");
    expect(hits).toEqual(["primary", "backup"]);
    releaseTransient();
    expect(await lateTransient).toBe("answered");
    const [health] = await withMemberHealth([pool]);
    expect(health.members[0].benchReason).toBe("credit_exhausted (429)");
    const until = Date.parse(health.members[0].benchedUntil ?? "");
    expect(until - now).toBeGreaterThanOrEqual(
      (cooldownSeconds ?? 3600) * 1000,
    );
    expect(until - now).toBeLessThan((cooldownSeconds ?? 3600) * 1000 + 5000);
    hits.length = 0;
    await run();
    expect(hits).toEqual(["backup"]);
    allDepleted = true;
    await expect(run()).rejects.toThrow();
    hits.length = 0;
    await expect(run()).rejects.toThrow("cooling down after credit exhaustion");
    expect(hits).toEqual([]);
    await expect(run(plan)).rejects.toThrow(
      "cooling down after credit exhaustion",
    );
    expect(hits).toEqual([]);
    // Advance only Date.now, so real persistence I/O remains live.
    const clock = vi.spyOn(Date, "now").mockReturnValue(until + 10_000);
    recovered = true;
    try {
      expect(await run()).toBe("answered");
      expect(hits).toEqual(["primary"]);
    } finally {
      clock.mockRestore();
    }
    expect(plan.members).toHaveLength(2);
  });
}
