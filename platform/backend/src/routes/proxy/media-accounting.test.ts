import { describe, expect, test } from "vitest";
import { InteractionModel } from "@/models";
import EnvironmentDefaultUserLimitModel from "@/models/environment-default-user-limit";
import LimitModel, { LimitValidationService } from "@/models/limit";
import { test as fixtureTest } from "@/test";
import type { GatewayAgent } from "@/types";
import { drainBackgroundWork } from "@/utils/background-work";
import {
  applyInputTokenFallback,
  buildInteractionRecord,
  calculateInteractionCosts,
  calculateUsageCost,
} from "./llm-proxy-helpers";

describe("unavailable media accounting", () => {
  test.each([
    "usageUnavailable",
    "costUnavailable",
  ] as const)("does not price or estimate %s in any accounting mode", async (flag) => {
    const usage = { inputTokens: 0, outputTokens: 9, [flag]: true };
    expect(
      applyInputTokenFallback({
        usage,
        provider: "openai",
        providerMessages: [{ role: "user", content: "Estimate nothing" }],
        tools: [],
        model: "tts-alias",
      }),
    ).toBe(usage);
    for (const mode of ["off", "shadow", "enforce"] as const) {
      expect(
        await calculateUsageCost({
          model: "tts-alias",
          provider: "openai",
          usage,
          usageAccountingMode: mode,
        }),
      ).toBeUndefined();
      const costs = await calculateInteractionCosts({
        actualModel: "tts-alias",
        providerName: "openai",
        usage,
        usageAccountingMode: mode,
      });
      expect(costs.actualCost).toBeUndefined();
      expect(costs.billingUsage).toBeUndefined();
      const row = buildInteractionRecord({
        agent: { id: "fixture" } as GatewayAgent,
        billingMode: "metered",
        providerType: "openai:chatCompletions",
        request: {},
        processedRequest: {},
        response: {},
        actualModel: "tts-alias",
        usage,
        costs,
      });
      expect(row.cost).toBeNull();
      expect(row.inputTokens).toBe(flag === "usageUnavailable" ? null : 0);
      expect(row.outputTokens).toBe(flag === "usageUnavailable" ? null : 9);
    }
  });
});

fixtureTest(
  "preserves known media tokens without repricing them into cost-limit accumulators",
  async ({ makeAgent }) => {
    const agent = await makeAgent();
    const limit = await LimitModel.create({
      entityType: "agent",
      entityId: agent.id,
      limitType: "token_cost",
      limitValue: 100,
      model: ["media-alias"],
      lastCleanup: new Date(),
    });
    const usage = { inputTokens: 7, outputTokens: 9, costUnavailable: true };
    const costs = await calculateInteractionCosts({
      actualModel: "media-alias",
      providerName: "azure",
      usage,
    });
    const row = buildInteractionRecord({
      agent,
      billingMode: "metered",
      providerType: "azure:images",
      request: { model: "media-alias", prompt: "Synthetic." },
      processedRequest: {},
      response: { created: 1, data: [] },
      actualModel: "media-alias",
      usage,
      costs,
    });
    const created = await InteractionModel.create(row);
    await drainBackgroundWork();
    expect(created).toMatchObject({
      inputTokens: 7,
      outputTokens: 9,
      cost: null,
      response: {
        __mediaUsage: { costAvailable: false, tokensAvailable: true },
      },
    });
    const counters = await LimitModel.getRawModelUsage(limit.id);
    expect(
      counters.every(
        (counter) =>
          counter.currentUsageTokensIn === 0 &&
          counter.currentUsageTokensOut === 0,
      ),
    ).toBe(true);
  },
);

fixtureTest(
  "refuses unpriced media against applicable budgets and preserves unrelated-model access",
  async ({ makeAgent }) => {
    const agent = await makeAgent();
    await LimitModel.create({
      entityType: "agent",
      entityId: agent.id,
      limitType: "token_cost",
      limitValue: 100,
      model: ["media-alias"],
      lastCleanup: new Date(),
    });
    await expect(
      LimitValidationService.checkLimitsBeforeRequest({
        agentId: agent.id,
        unpricedMediaModel: "media-alias",
      }),
    ).rejects.toMatchObject({ statusCode: 422 });
    expect(
      await LimitValidationService.checkLimitsBeforeRequest({
        agentId: agent.id,
        unpricedMediaModel: "other-model",
      }),
    ).toBeNull();
  },
);

fixtureTest(
  "refuses unpriced media against a default user budget",
  async ({ makeAgent, makeUser }) => {
    const agent = await makeAgent();
    const user = await makeUser();
    await EnvironmentDefaultUserLimitModel.create({
      organizationId: agent.organizationId,
      environmentId: null,
      limitValue: 100,
      model: ["media-alias"],
      cleanupInterval: "calendar_month",
    });
    await expect(
      LimitValidationService.checkLimitsBeforeRequest({
        agentId: agent.id,
        userId: user.id,
        unpricedMediaModel: "media-alias",
      }),
    ).rejects.toMatchObject({ statusCode: 422 });
  },
);
