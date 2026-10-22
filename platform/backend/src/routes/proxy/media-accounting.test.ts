import { describe, expect, test } from "vitest";
import type { GatewayAgent } from "@/types";
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
