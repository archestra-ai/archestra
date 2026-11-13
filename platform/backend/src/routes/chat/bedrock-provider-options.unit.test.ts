import { createAmazonBedrock } from "@ai-sdk/amazon-bedrock";
import { describe, expect, test } from "vitest";
import { buildBedrockThinkingOptions } from "./bedrock-provider-options";

const base = {
  provider: "bedrock",
  selectedModel: "us.amazon.nova-2-lite-v1:0",
  thinkingEffort: "medium" as const,
  maxOutputTokens: 32768,
  hasExplicitOutputLimit: false,
};

describe("Bedrock chat reasoning", () => {
  test.each([
    "low",
    "medium",
  ] as const)("preserves the output budget at %s", (thinkingEffort) => {
    expect(buildBedrockThinkingOptions({ ...base, thinkingEffort })).toEqual({
      maxOutputTokens: 32768,
      providerOptions: {
        reasoningConfig: {
          type: "enabled",
          maxReasoningEffort: thinkingEffort,
        },
      },
    });
  });

  test("high omits only the automatic output budget", () => {
    expect(
      buildBedrockThinkingOptions({ ...base, thinkingEffort: "high" })
        ?.maxOutputTokens,
    ).toBeUndefined();
    expect(() =>
      buildBedrockThinkingOptions({
        ...base,
        thinkingEffort: "high",
        hasExplicitOutputLimit: true,
      }),
    ).toThrow("configured output-token limit");
  });

  test("high rejects an explicit temperature override, including zero", () => {
    expect(() =>
      buildBedrockThinkingOptions({
        ...base,
        thinkingEffort: "high",
        temperature: 0,
      }),
    ).toThrow("temperature override");
  });

  test("default preserves the provider's existing behavior", () => {
    expect(
      buildBedrockThinkingOptions({ ...base, thinkingEffort: null }),
    ).toBeUndefined();
  });

  test.each([
    "global.openai.gpt-6-luna",
    "amazon.nova-lite-v1:0",
    "anthropic.claude-haiku-4-5",
    "custom-model",
  ])("does not guess a dialect for %s", (selectedModel) => {
    expect(
      buildBedrockThinkingOptions({ ...base, selectedModel }),
    ).toBeUndefined();
  });

  test("ignores non-Bedrock providers", () => {
    expect(
      buildBedrockThinkingOptions({ ...base, provider: "openai" }),
    ).toBeUndefined();
  });

  test.each([
    "low",
    "medium",
    "high",
  ] as const)("Claude adaptive %s requests summarized reasoning without inflating the budget", (thinkingEffort) => {
    expect(
      buildBedrockThinkingOptions({
        ...base,
        selectedModel: "us.anthropic.claude-sonnet-4-6",
        thinkingEffort,
      }),
    ).toEqual({
      maxOutputTokens: 32768,
      providerOptions: {
        reasoningConfig: {
          type: "adaptive",
          maxReasoningEffort: thinkingEffort,
          display: "summarized",
        },
      },
    });
  });

  test.each([
    {
      selectedModel: "us.amazon.nova-2-lite-v1:0",
      thinkingEffort: "medium" as const,
      expected: {
        reasoningConfig: { type: "enabled", maxReasoningEffort: "medium" },
      },
      maxTokens: 32768,
    },
    {
      selectedModel: "global.amazon.nova-2-lite-v1:0",
      thinkingEffort: "high" as const,
      expected: {
        reasoningConfig: { type: "enabled", maxReasoningEffort: "high" },
      },
      maxTokens: undefined,
    },
    {
      selectedModel: "us.anthropic.claude-sonnet-4-6",
      thinkingEffort: "high" as const,
      expected: {
        thinking: { type: "adaptive", display: "summarized" },
        output_config: { effort: "high" },
      },
      maxTokens: 32768,
    },
  ])("the pinned SDK sends the actual Converse dialect for $selectedModel/$thinkingEffort", async ({
    selectedModel,
    thinkingEffort,
    expected,
    maxTokens,
  }) => {
    const requests: Record<string, unknown>[] = [];
    const provider = createAmazonBedrock({
      apiKey: "synthetic-provider-key",
      region: "us-east-2",
      fetch: async (_url, init) => {
        requests.push(JSON.parse(String(init?.body)));
        return Response.json({
          output: { message: { role: "assistant", content: [{ text: "42" }] } },
          stopReason: "end_turn",
          usage: { inputTokens: 4, outputTokens: 1, totalTokens: 5 },
          metrics: { latencyMs: 1 },
        });
      },
    });
    const options = buildBedrockThinkingOptions({
      ...base,
      selectedModel,
      thinkingEffort,
    });
    await provider(selectedModel).doGenerate({
      prompt: [{ role: "user", content: [{ type: "text", text: "17 + 25" }] }],
      maxOutputTokens: options?.maxOutputTokens,
      providerOptions: { bedrock: options?.providerOptions ?? {} },
    });
    expect(requests).toHaveLength(1);
    expect(requests[0].additionalModelRequestFields).toEqual(expected);
    expect(requests[0].inferenceConfig).toEqual(
      maxTokens === undefined ? undefined : { maxTokens },
    );
  });
});
