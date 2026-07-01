import { ModelModel } from "@/models";
import { describe, expect, test } from "@/test";
import { TiktokenTokenizer } from "@/tokenizers";
import type { CommonMcpToolDefinition } from "@/types";
import {
  calculateCacheCost,
  calculateCost,
  estimateToolTokens,
} from "./cost-optimization";

describe("calculateCost", () => {
  test("returns undefined when there is no usage at all", async () => {
    expect(await calculateCost("gpt-4o", null, null, "openai")).toBeUndefined();
    expect(await calculateCost("gpt-4o", 0, 0, "openai")).toBeUndefined();
  });

  test("costs output even when input is 0 (fully-cached request)", async () => {
    // Default pricing $50/M: 100 output = 100/1M * $50 = $0.005. A fully-cached
    // turn has inputTokens 0 but must still be costed (cache read + output).
    const cost = await calculateCost("unknown-cached", 0, 100, "openai", {
      readTokens: 1000,
    });
    // output $0.005 + cache read 1000/1M * $50 * 0.25 = $0.0125 => $0.0175
    expect(cost).toBeCloseTo(0.0175);
  });

  test("calculates cost using models.dev synced pricing", async () => {
    await ModelModel.create({
      externalId: "openai/gpt-4o",
      provider: "openai",
      modelId: "gpt-4o",
      inputModalities: ["text"],
      outputModalities: ["text"],
      promptPricePerToken: "0.000005",
      completionPricePerToken: "0.000015",
      lastSyncedAt: new Date(),
    });

    // models.dev pricing: $5/M input, $15/M output
    // 1000 input tokens = 1000/1M * $5 = $0.005
    // 500 output tokens = 500/1M * $15 = $0.0075
    // Total = $0.0125
    const cost = await calculateCost("gpt-4o", 1000, 500, "openai");
    expect(cost).toBeCloseTo(0.0125);
  });

  test("calculates cost using custom pricing when set", async () => {
    const model = await ModelModel.create({
      externalId: "anthropic/claude-3-opus",
      provider: "anthropic",
      modelId: "claude-3-opus",
      inputModalities: ["text"],
      outputModalities: ["text"],
      promptPricePerToken: "0.000015",
      completionPricePerToken: "0.000075",
      lastSyncedAt: new Date(),
    });

    await ModelModel.update(model.id, {
      customPricePerMillionInput: "10.00",
      customPricePerMillionOutput: "30.00",
    });

    // Custom pricing: $10/M input, $30/M output
    // 2000 input tokens = 2000/1M * $10 = $0.02
    // 1000 output tokens = 1000/1M * $30 = $0.03
    // Total = $0.05
    const cost = await calculateCost("claude-3-opus", 2000, 1000, "anthropic");
    expect(cost).toBeCloseTo(0.05);
  });

  test("falls back to default pricing when model not in database", async () => {
    // Default pricing for non-mini models: $50/M input, $50/M output
    // 1000 input tokens = 1000/1M * $50 = $0.05
    // 1000 output tokens = 1000/1M * $50 = $0.05
    // Total = $0.10
    const cost = await calculateCost("unknown-model", 1000, 1000, "openai");
    expect(cost).toBeCloseTo(0.1);
  });

  test("uses correct provider to disambiguate models", async () => {
    await ModelModel.create({
      externalId: "openai/shared-model",
      provider: "openai",
      modelId: "shared-model",
      inputModalities: ["text"],
      outputModalities: ["text"],
      promptPricePerToken: "0.000010",
      completionPricePerToken: "0.000030",
      lastSyncedAt: new Date(),
    });
    await ModelModel.create({
      externalId: "anthropic/shared-model",
      provider: "anthropic",
      modelId: "shared-model",
      inputModalities: ["text"],
      outputModalities: ["text"],
      promptPricePerToken: "0.000001",
      completionPricePerToken: "0.000003",
      lastSyncedAt: new Date(),
    });

    // OpenAI pricing: $10/M input, $30/M output
    // 1000 input = $0.01, 1000 output = $0.03 → $0.04
    const openaiCost = await calculateCost(
      "shared-model",
      1000,
      1000,
      "openai",
    );
    expect(openaiCost).toBeCloseTo(0.04);

    // Anthropic pricing: $1/M input, $3/M output
    // 1000 input = $0.001, 1000 output = $0.003 → $0.004
    const anthropicCost = await calculateCost(
      "shared-model",
      1000,
      1000,
      "anthropic",
    );
    expect(anthropicCost).toBeCloseTo(0.004);
  });

  test("adds cache read + write cost using provider multipliers", async () => {
    await ModelModel.create({
      externalId: "anthropic/cache-model",
      provider: "anthropic",
      modelId: "cache-model",
      inputModalities: ["text"],
      outputModalities: ["text"],
      promptPricePerToken: "0.000010", // $10/M input
      completionPricePerToken: "0.000030", // $30/M output
      lastSyncedAt: new Date(),
    });

    // input 1000 = $0.01, output 500 = $0.015
    // cache read 2000/1M * $10 * 0.1 = $0.002
    // cache write 1000/1M * $10 * 1.25 = $0.0125
    // total = 0.0395
    const cost = await calculateCost("cache-model", 1000, 500, "anthropic", {
      readTokens: 2000,
      writeTokens: 1000,
    });
    expect(cost).toBeCloseTo(0.0395);
  });

  test("bills the 1h cache-write portion at 2x in the all-in cost", async () => {
    await ModelModel.create({
      externalId: "anthropic/cache-cost-1h",
      provider: "anthropic",
      modelId: "cache-cost-1h",
      inputModalities: ["text"],
      outputModalities: ["text"],
      promptPricePerToken: "0.000010", // $10/M input
      completionPricePerToken: "0.000030", // $30/M output
      lastSyncedAt: new Date(),
    });

    // input 0.01 + output 0.015 + read 0.002 (2000*$10*0.1)
    // of 1000 writes, 400 are 1h (2x = 0.008) and 600 are 5m (1.25x = 0.0075)
    // total = 0.01 + 0.015 + 0.002 + 0.0075 + 0.008 = 0.0425
    const cost = await calculateCost("cache-cost-1h", 1000, 500, "anthropic", {
      readTokens: 2000,
      writeTokens: 1000,
      write1hTokens: 400,
    });
    expect(cost).toBeCloseTo(0.0425);
  });

  test("prefers explicit synced cache prices over the provider multiplier", async () => {
    await ModelModel.create({
      externalId: "anthropic/explicit-cache",
      provider: "anthropic",
      modelId: "explicit-cache",
      inputModalities: ["text"],
      outputModalities: ["text"],
      promptPricePerToken: "0.000010", // $10/M input
      completionPricePerToken: "0.000030", // $30/M output
      cacheReadPricePerToken: "0.000002", // $2/M (multiplier would give $1/M)
      cacheWritePricePerToken: "0.000020", // $20/M (multiplier would give $12.5/M)
      lastSyncedAt: new Date(),
    });

    // input 0.01 + output 0.015 + read 2000/1M*$2 (0.004) + write 1000/1M*$20 (0.02)
    const cost = await calculateCost("explicit-cache", 1000, 500, "anthropic", {
      readTokens: 2000,
      writeTokens: 1000,
    });
    expect(cost).toBeCloseTo(0.049);
  });

  test("uses custom cache price overrides over synced/derived prices", async () => {
    const model = await ModelModel.create({
      externalId: "anthropic/custom-cache",
      provider: "anthropic",
      modelId: "custom-cache",
      inputModalities: ["text"],
      outputModalities: ["text"],
      promptPricePerToken: "0.000010",
      completionPricePerToken: "0.000030",
      cacheReadPricePerToken: "0.000002",
      cacheWritePricePerToken: "0.000020",
      lastSyncedAt: new Date(),
    });
    await ModelModel.update(model.id, {
      customPricePerMillionCacheRead: "1.00",
      customPricePerMillionCacheWrite: "5.00",
    });

    // input 0.01 + output 0.015 + read 2000/1M*$1 (0.002) + write 1000/1M*$5 (0.005)
    const cost = await calculateCost("custom-cache", 1000, 500, "anthropic", {
      readTokens: 2000,
      writeTokens: 1000,
    });
    expect(cost).toBeCloseTo(0.032);
  });
});

describe("calculateCacheCost", () => {
  test("returns undefined when there are no cache tokens", async () => {
    expect(await calculateCacheCost("gpt-4o", "openai", 0, 0)).toBeUndefined();
  });

  test("splits cache cost and net savings using multipliers", async () => {
    await ModelModel.create({
      externalId: "anthropic/cache-breakdown",
      provider: "anthropic",
      modelId: "cache-breakdown",
      inputModalities: ["text"],
      outputModalities: ["text"],
      promptPricePerToken: "0.000010", // $10/M input
      completionPricePerToken: "0.000030",
      lastSyncedAt: new Date(),
    });

    // read 2000/1M * $10 = $0.02 full → actual 0.1x = $0.002, saved $0.018
    // write 1000/1M * $10 = $0.01 full → actual 1.25x = $0.0125, surcharge $0.0025
    const result = await calculateCacheCost(
      "cache-breakdown",
      "anthropic",
      2000,
      1000,
    );
    expect(result?.cacheCost).toBeCloseTo(0.0145);
    expect(result?.cacheSavings).toBeCloseTo(0.0155);
  });

  test("bills the 1-hour write portion at 2x, the rest at the 5m rate", async () => {
    await ModelModel.create({
      externalId: "anthropic/cache-1h",
      provider: "anthropic",
      modelId: "cache-1h",
      inputModalities: ["text"],
      outputModalities: ["text"],
      promptPricePerToken: "0.000010", // $10/M input
      completionPricePerToken: "0.000030",
      lastSyncedAt: new Date(),
    });

    // read 2000 → 0.002 cost / 0.018 saved.
    // of 1000 write tokens, 400 are 1h (2x) and 600 are 5m (1.25x):
    //   cost  = 0.002 + 600/1M*$10*1.25 (0.0075) + 400/1M*$10*2 (0.008) = 0.0175
    //   saved = 0.018 - 600/1M*$10*0.25 (0.0015) - 400/1M*$10*1.0 (0.004) = 0.0125
    const result = await calculateCacheCost(
      "cache-1h",
      "anthropic",
      2000,
      1000,
      400,
    );
    expect(result?.cacheCost).toBeCloseTo(0.0175);
    expect(result?.cacheSavings).toBeCloseTo(0.0125);
  });

  test("computes cache cost from explicit prices even when the provider has no multiplier", async () => {
    await ModelModel.create({
      externalId: "cohere/cache-explicit",
      provider: "cohere",
      modelId: "cache-explicit",
      inputModalities: ["text"],
      outputModalities: ["text"],
      promptPricePerToken: "0.000010", // $10/M input
      completionPricePerToken: "0.000030",
      cacheReadPricePerToken: "0.000001", // $1/M
      cacheWritePricePerToken: "0.000012", // $12/M
      lastSyncedAt: new Date(),
    });

    // read 2000/1M*$1 = 0.002 cost; write 1000/1M*$12 = 0.012 cost → 0.014
    // read saved 2000/1M*($10-$1) = 0.018; write surcharge 1000/1M*($12-$10) = 0.002
    const result = await calculateCacheCost(
      "cache-explicit",
      "cohere",
      2000,
      1000,
    );
    expect(result?.cacheCost).toBeCloseTo(0.014);
    expect(result?.cacheSavings).toBeCloseTo(0.016);
  });

  test("skips an unpriced cache direction instead of fabricating savings", async () => {
    // A provider with no cache multiplier and only a synced cache-read price:
    // the write direction is genuinely unpriced and must be skipped, not zeroed.
    await ModelModel.create({
      externalId: "cohere/cache-read-only",
      provider: "cohere",
      modelId: "cache-read-only",
      inputModalities: ["text"],
      outputModalities: ["text"],
      promptPricePerToken: "0.00001", // $10/M input
      completionPricePerToken: "0.00003",
      cacheReadPricePerToken: "0.000001", // $1/M read, no write synced
      lastSyncedAt: new Date(),
    });

    // read 2000/1M*$1 = 0.002 cost; read saved 2000/1M*($10-$1) = 0.018.
    // 1000 write tokens are unpriced → contribute no cost and no savings.
    const result = await calculateCacheCost(
      "cache-read-only",
      "cohere",
      2000,
      1000,
    );
    expect(result?.cacheCost).toBeCloseTo(0.002);
    expect(result?.cacheSavings).toBeCloseTo(0.018);
    expect(result?.cacheReadSavings).toBeCloseTo(0.018);
  });
});

describe("estimateToolTokens", () => {
  const tokenizer = new TiktokenTokenizer();

  test("returns 0 for empty tools array", () => {
    expect(estimateToolTokens([], tokenizer)).toBe(0);
  });

  test("estimates tokens for a single tool", () => {
    const tools: CommonMcpToolDefinition[] = [
      {
        name: "get_weather",
        description: "Get the current weather for a location",
        inputSchema: {
          type: "object",
          properties: {
            location: { type: "string", description: "City name" },
          },
          required: ["location"],
        },
      },
    ];

    const tokens = estimateToolTokens(tools, tokenizer);
    expect(tokens).toBeGreaterThan(0);
  });

  test("estimates more tokens for tools with large schemas", () => {
    const smallTool: CommonMcpToolDefinition[] = [
      {
        name: "ping",
        inputSchema: {},
      },
    ];

    const largeTool: CommonMcpToolDefinition[] = [
      {
        name: "complex_query",
        description: "Execute a complex database query with many parameters",
        inputSchema: {
          type: "object",
          properties: {
            table: { type: "string" },
            columns: { type: "array", items: { type: "string" } },
            where: {
              type: "object",
              properties: {
                field: { type: "string" },
                operator: { type: "string", enum: ["eq", "gt", "lt", "in"] },
                value: { type: "string" },
              },
            },
            orderBy: { type: "string" },
            limit: { type: "number" },
            offset: { type: "number" },
          },
          required: ["table"],
        },
      },
    ];

    expect(estimateToolTokens(largeTool, tokenizer)).toBeGreaterThan(
      estimateToolTokens(smallTool, tokenizer),
    );
  });

  test("accumulates tokens across multiple tools", () => {
    const singleTool: CommonMcpToolDefinition[] = [
      {
        name: "tool_a",
        description: "First tool",
        inputSchema: { type: "object" },
      },
    ];

    const multipleTools: CommonMcpToolDefinition[] = [
      {
        name: "tool_a",
        description: "First tool",
        inputSchema: { type: "object" },
      },
      {
        name: "tool_b",
        description: "Second tool",
        inputSchema: { type: "object" },
      },
      {
        name: "tool_c",
        description: "Third tool",
        inputSchema: { type: "object" },
      },
    ];

    expect(estimateToolTokens(multipleTools, tokenizer)).toBeGreaterThan(
      estimateToolTokens(singleTool, tokenizer),
    );
  });

  test("handles tools without description", () => {
    const tools: CommonMcpToolDefinition[] = [
      {
        name: "no_desc",
        inputSchema: { type: "object" },
      },
    ];

    const tokens = estimateToolTokens(tools, tokenizer);
    expect(tokens).toBeGreaterThan(0);
  });
});
