import { ModelModel } from "@/models";
import { describe, expect, test } from "@/test";
import { TiktokenTokenizer } from "@/tokenizers";
import type { CommonMcpToolDefinition } from "@/types";
import { calculateCost, estimateToolTokens } from "./cost-optimization";

describe("calculateCost", () => {
  test("returns undefined when inputTokens is null", async () => {
    const cost = await calculateCost("gpt-4o", null, 100, "openai");
    expect(cost).toBeUndefined();
  });

  test("returns undefined when outputTokens is null", async () => {
    const cost = await calculateCost("gpt-4o", 100, null, "openai");
    expect(cost).toBeUndefined();
  });

  test("returns undefined when inputTokens is 0", async () => {
    const cost = await calculateCost("gpt-4o", 0, 100, "openai");
    expect(cost).toBeUndefined();
  });

  test("returns undefined when outputTokens is 0", async () => {
    const cost = await calculateCost("gpt-4o", 100, 0, "openai");
    expect(cost).toBeUndefined();
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
