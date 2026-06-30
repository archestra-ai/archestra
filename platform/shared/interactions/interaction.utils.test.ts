import { describe, expect, it, test } from "vitest";
import { calculateCostSavings, DynamicInteraction } from "./interaction.utils";
import type { Interaction } from "./llmProviders/common";

describe("DynamicInteraction with a failed-interaction error response", () => {
  // A failed upstream call is persisted with the provider `type` but an
  // `{ error }` response instead of a provider response.
  const errorInteraction = {
    id: "interaction-1",
    type: "anthropic:messages",
    model: "claude-3-5-sonnet-20241022",
    request: {
      model: "claude-3-5-sonnet-20241022",
      max_tokens: 64,
      messages: [{ role: "user", content: "Hello" }],
    },
    response: { error: "Upstream provider returned an error response" },
  } as unknown as Interaction;

  it("surfaces the error text as the last assistant response", () => {
    const interaction = new DynamicInteraction(errorInteraction);
    expect(interaction.getLastAssistantResponse()).toBe(
      "Upstream provider returned an error response",
    );
  });

  it("renders the error as an assistant message instead of throwing", () => {
    const interaction = new DynamicInteraction(errorInteraction);
    const messages = interaction.mapToUiMessages();
    const last = messages[messages.length - 1];
    expect(last.role).toBe("assistant");
    expect(last.parts).toContainEqual({
      type: "text",
      text: "Upstream provider returned an error response",
    });
  });

  it("reports no tools for a failed interaction without reading the response", () => {
    // openai mappers iterate `response.choices`, which throws on an `{ error }`
    // response — so this exercises the guard (anthropic would no-op regardless).
    const openAiErrorInteraction = {
      id: "interaction-2",
      type: "openai:chatCompletions",
      model: "gpt-4o-mini",
      request: {
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: "Hello" }],
      },
      response: { error: "Upstream provider returned an error response" },
    } as unknown as Interaction;

    const interaction = new DynamicInteraction(openAiErrorInteraction);
    expect(interaction.getToolNamesUsed()).toEqual([]);
    expect(interaction.getToolNamesRequested()).toEqual([]);
    expect(interaction.getToolNamesRefused()).toEqual([]);
    expect(interaction.getToolRefusedCount()).toBe(0);
  });
});

describe("DynamicInteraction with a normal provider response", () => {
  // A successful call delegates every accessor to the provider mapper; the
  // failed-interaction guard must not suppress real response data.
  const okInteraction = {
    id: "ok-1",
    type: "openai:chatCompletions",
    model: "gpt-4o-mini",
    request: {
      model: "gpt-4o-mini",
      messages: [
        { role: "user", content: "weather?" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "u1",
              type: "function",
              function: { name: "search", arguments: "{}" },
            },
          ],
        },
        { role: "tool", tool_call_id: "u1", content: "sunny" },
        { role: "user", content: "thanks" },
      ],
    },
    response: {
      id: "r1",
      object: "chat.completion",
      created: 1,
      model: "gpt-4o-mini",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: "Hello back",
            refusal: null,
            tool_calls: [
              {
                id: "c1",
                type: "function",
                function: { name: "get_weather", arguments: "{}" },
              },
            ],
          },
          finish_reason: "tool_calls",
          logprobs: null,
        },
      ],
    },
  } as unknown as Interaction;

  it("delegates getLastAssistantResponse to the provider mapper", () => {
    expect(
      new DynamicInteraction(okInteraction).getLastAssistantResponse(),
    ).toBe("Hello back");
  });

  it("delegates tool extraction instead of returning the failed-interaction defaults", () => {
    const interaction = new DynamicInteraction(okInteraction);
    expect(interaction.getToolNamesUsed()).toEqual(["search"]);
    expect(interaction.getToolNamesRequested()).toEqual(["get_weather"]);
  });

  it("delegates mapToUiMessages to the provider mapper", () => {
    const messages = new DynamicInteraction(okInteraction).mapToUiMessages();
    const hasAssistantText = messages.some(
      (m) =>
        m.role === "assistant" &&
        m.parts.some((p) => p.type === "text" && p.text === "Hello back"),
    );
    expect(hasAssistantText).toBe(true);
  });
});

describe("DynamicInteraction dispatch and guard edges", () => {
  it("recovers when the provider mapper throws on an { error } response", () => {
    // openai's mapToUiMessages reads response.choices, which throws on an
    // `{ error }` body — the guard must catch it and still append the error turn.
    const openAiErrorInteraction = {
      id: "err-openai",
      type: "openai:chatCompletions",
      model: "gpt-4o-mini",
      request: {
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: "Hello" }],
      },
      response: { error: "boom" },
    } as unknown as Interaction;

    const messages = new DynamicInteraction(
      openAiErrorInteraction,
    ).mapToUiMessages();
    const last = messages[messages.length - 1];
    expect(last.role).toBe("assistant");
    expect(last.parts).toContainEqual({ type: "text", text: "boom" });
  });

  it("treats a non-string error field as a normal response, not a failure", () => {
    // getToolNamesUsed reads only the request, so it delegates without throwing;
    // a delegated result proves `{ error: 123 }` is not read as a failed call.
    const nonStringErrorInteraction = {
      id: "err-nonstring",
      type: "openai:chatCompletions",
      model: "gpt-4o-mini",
      request: {
        model: "gpt-4o-mini",
        messages: [
          {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "u1",
                type: "function",
                function: { name: "search", arguments: "{}" },
              },
            ],
          },
        ],
      },
      response: { error: 123 },
    } as unknown as Interaction;

    expect(
      new DynamicInteraction(nonStringErrorInteraction).getToolNamesUsed(),
    ).toEqual(["search"]);
  });

  it("constructs a gemini:embeddings interaction via the OpenAI-compatible factory", () => {
    const embeddingInteraction = {
      id: "emb-1",
      type: "gemini:embeddings",
      model: "text-embedding-004",
      request: { model: "text-embedding-004", input: ["hello"] },
      response: {
        object: "list",
        data: [{ object: "embedding", embedding: [0.1, 0.2], index: 0 }],
        model: "text-embedding-004",
        usage: { prompt_tokens: 1, total_tokens: 1 },
      },
    } as unknown as Interaction;

    expect(() => new DynamicInteraction(embeddingInteraction)).not.toThrow();
    expect(
      new DynamicInteraction(embeddingInteraction).getToolNamesRequested(),
    ).toEqual([]);
  });

  it("throws for an unsupported interaction type", () => {
    const unsupported = {
      id: "bogus-1",
      type: "bogus:type",
      model: "x",
      request: {},
      response: {},
    } as unknown as Interaction;

    expect(() => new DynamicInteraction(unsupported)).toThrow(
      /Unsupported interaction type/,
    );
  });
});

describe("calculateCostSavings", () => {
  test("treats the stored cost as the actual cost and never double-counts TOON savings", () => {
    // Regression: previously `actualCost` was derived as
    // `baselineCost - totalSavings`, which simplifies to `cost - toonCostSavings`.
    // When TOON savings exceeded the (already TOON-reduced) cost this produced a
    // negative actual cost and a savings percentage well above 100%.
    const result = calculateCostSavings({
      cost: "0.05",
      baselineCost: "0.3926",
      toonCostSavings: "1.8",
      toonTokensBefore: 10_000,
      toonTokensAfter: 1_000,
    });

    // Actual cost is exactly the stored spend — never negative.
    expect(result.actualCost).toBeCloseTo(0.05, 10);
    // Model optimization savings = baselineCost - cost.
    expect(result.costOptimizationSavings).toBeCloseTo(0.3426, 10);
    // Total savings = model optimization + TOON compression.
    expect(result.totalSavings).toBeCloseTo(0.3426 + 1.8, 10);
    // Estimated cost sits exactly totalSavings above the actual spend.
    expect(result.estimatedCost).toBeCloseTo(0.05 + 0.3426 + 1.8, 10);
    // Percentage is bounded to 0–100 for non-negative savings.
    expect(result.savingsPercent).toBeGreaterThan(0);
    expect(result.savingsPercent).toBeLessThan(100);
    expect(result.toonTokensSaved).toBe(9_000);
    expect(result.hasSavings).toBe(true);
  });

  test("reports no savings when there is no optimization or compression", () => {
    const result = calculateCostSavings({
      cost: "0.25",
      baselineCost: "0.25",
      toonCostSavings: "0",
      toonTokensBefore: null,
      toonTokensAfter: null,
    });

    expect(result.actualCost).toBeCloseTo(0.25, 10);
    expect(result.estimatedCost).toBeCloseTo(0.25, 10);
    expect(result.totalSavings).toBeCloseTo(0, 10);
    expect(result.savingsPercent).toBe(0);
    expect(result.toonTokensSaved).toBeNull();
    expect(result.hasSavings).toBe(false);
  });

  test("handles only model-optimization savings (no TOON)", () => {
    const result = calculateCostSavings({
      cost: "0.10",
      baselineCost: "0.40",
      toonCostSavings: null,
      toonTokensBefore: null,
      toonTokensAfter: null,
    });

    expect(result.actualCost).toBeCloseTo(0.1, 10);
    expect(result.costOptimizationSavings).toBeCloseTo(0.3, 10);
    expect(result.totalSavings).toBeCloseTo(0.3, 10);
    expect(result.estimatedCost).toBeCloseTo(0.4, 10);
    // 0.3 / 0.4 = 75%
    expect(result.savingsPercent).toBeCloseTo(75, 10);
  });

  test("guards against a zero estimated cost", () => {
    const result = calculateCostSavings({
      cost: null,
      baselineCost: null,
      toonCostSavings: null,
      toonTokensBefore: null,
      toonTokensAfter: null,
    });

    expect(result.actualCost).toBe(0);
    expect(result.estimatedCost).toBe(0);
    expect(result.savingsPercent).toBe(0);
  });
});
