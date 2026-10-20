import { describe, expect, test } from "vitest";
import {
  mergeAnthropicUsage,
  normalizeAnthropicUsage,
  parseUsageAccountingMode,
  priceTokens,
  sumMoney,
  type TokenPrices,
} from "./billable-usage";

const rates: TokenPrices = {
  input: "1",
  output: "5",
  cacheRead: "0.10",
  cacheWrite: "1.25",
  cacheWrite1h: "2",
  source: "custom",
};
const advisorRates: TokenPrices = {
  input: "5",
  output: "25",
  cacheRead: "0.50",
  cacheWrite: "6.25",
  cacheWrite1h: "10",
  source: "custom",
};
const advisor = {
  type: "advisor_message",
  model: "advisor",
  input_tokens: 300,
  output_tokens: 40,
  cache_read_input_tokens: 500,
  cache_creation_input_tokens: 100,
  cache_creation: { ephemeral_1h_input_tokens: 40 },
};
function usage(extra: unknown[] = []) {
  return {
    input_tokens: 300,
    output_tokens: 50,
    iterations: [
      { type: "message", input_tokens: 100, output_tokens: 20 },
      advisor,
      { type: "message", input_tokens: 200, output_tokens: 30 },
      ...extra,
    ],
  };
}
describe("cumulative provider accounting", () => {
  test("prices each disjoint iteration once, including identical advisor calls and cache TTLs", () => {
    const normalized = normalizeAnthropicUsage(usage(), "executor");
    expect(normalized.billingUsage?.status).toBe("complete");
    const costs =
      normalized.billingUsage?.components.map((component) =>
        priceTokens(
          component,
          component.model === "advisor" ? advisorRates : rates,
        ),
      ) ?? [];
    expect(sumMoney(costs.filter((_, index) => index !== 1))).toBe(
      "0.0005500000",
    );
    expect(costs[1]).toBe("0.0035250000");
    expect(sumMoney(costs)).toBe("0.0040750000");
    const repeated = normalizeAnthropicUsage(usage([advisor]), "executor");
    expect(
      sumMoney(
        repeated.billingUsage?.components.map((component) =>
          priceTokens(
            component,
            component.model === "advisor" ? advisorRates : rates,
          ),
        ) ?? [],
      ),
    ).toBe("0.0076000000");
  });
  test("replaces iteration snapshots, preserves omissions and nulls, honors supplied zeros", () => {
    const initial = {
      ...usage(),
      cache_read_input_tokens: 2000,
      cache_creation: { ephemeral_1h_input_tokens: 40 },
    };
    const merged = mergeAnthropicUsage(initial, {
      ...usage(),
      input_tokens: 0,
      cache_read_input_tokens: null,
      cache_creation: { ephemeral_1h_input_tokens: null },
    });
    expect(merged.input_tokens).toBe(0);
    expect(merged.cache_read_input_tokens).toBe(2000);
    expect(merged.cache_creation).toEqual({ ephemeral_1h_input_tokens: 40 });
    expect(merged.iterations as unknown[]).toHaveLength(3);
  });
  test("adds compaction without adding top-level executor counts twice", () => {
    const normalized = normalizeAnthropicUsage(
      {
        input_tokens: 300,
        output_tokens: 50,
        iterations: [
          { type: "compaction", input_tokens: 1000, output_tokens: 100 },
          { type: "message", input_tokens: 300, output_tokens: 50 },
        ],
      },
      "executor",
    );
    expect(normalized.billingUsage?.status).toBe("complete");
    expect(
      sumMoney(
        normalized.billingUsage?.components.map((component) =>
          priceTokens(component, rates),
        ) ?? [],
      ),
    ).toBe("0.0020500000");
    expect(
      priceTokens(
        {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 2000,
          cacheWriteTokens: 0,
          cacheWrite1hTokens: 0,
        },
        rates,
      ),
    ).toBe("0.0002000000");
  });
  test.each([
    { type: "message", input_tokens: 1, output_tokens: 2, cache_creation: [] },
    {
      type: "message",
      input_tokens: 1,
      output_tokens: 2,
      cache_creation_input_tokens: 2,
      cache_creation: { ephemeral_5m_input_tokens: 1 },
    },
    { type: "unknown", input_tokens: 1, output_tokens: 2 },
    { type: "advisor_message", input_tokens: 1, output_tokens: 2 },
    { type: "message", input_tokens: -1, output_tokens: 2 },
    {
      type: "message",
      input_tokens: 1,
      output_tokens: 2,
      cache_creation_input_tokens: 2,
      cache_creation: { ephemeral_1h_input_tokens: 3 },
    },
  ])("marks unsupported or malformed billing incomplete: %j", (iteration) => {
    expect(
      normalizeAnthropicUsage(
        { input_tokens: 1, output_tokens: 2, iterations: [iteration] },
        "executor",
      ).billingUsage?.status,
    ).toBe("incomplete");
  });
  test("rejects invalid modes and token arithmetic", () => {
    expect(parseUsageAccountingMode(undefined)).toBe("off");
    expect(() => parseUsageAccountingMode("client-choice")).toThrow();
    expect(() =>
      priceTokens(
        {
          inputTokens: Number.NaN,
          outputTokens: 1,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          cacheWrite1hTokens: 0,
        },
        rates,
      ),
    ).toThrow();
  });
});
