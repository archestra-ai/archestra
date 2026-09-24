import { describe, expect, test } from "vitest";
import { buildOpenAiThinkingProviderOptions } from "./openai-provider-options";

const base = {
  provider: "openai",
  thinkingEffort: "medium" as const,
};

describe("buildOpenAiThinkingProviderOptions", () => {
  test.each([
    "anthropic",
    "gemini",
    "perplexity",
  ])("leaves %s turns alone", (provider) => {
    expect(
      buildOpenAiThinkingProviderOptions({
        ...base,
        provider,
        selectedModel: "gpt-5.2",
      }),
    ).toBeUndefined();
  });

  test.each([
    "low",
    "medium",
    "high",
  ] as const)("%s reaches a reasoning model unchanged", (thinkingEffort) => {
    expect(
      buildOpenAiThinkingProviderOptions({
        ...base,
        selectedModel: "gpt-5.2",
        thinkingEffort,
      }),
    ).toEqual({ reasoningEffort: thinkingEffort });
  });

  test("no chosen depth sends no effort, leaving the model's own in place", () => {
    // gpt-5.1 through 5.4 default to `none`, so a level here would switch
    // reasoning on for chats nobody touched, and bill it.
    expect(
      buildOpenAiThinkingProviderOptions({
        ...base,
        selectedModel: "gpt-5.2",
        thinkingEffort: null,
      }),
    ).toBeUndefined();
  });

  test.each([
    // Non-reasoning families 400 on the field.
    "gpt-4o",
    "gpt-4.1",
    // Fixed at "high", so there is no depth to choose.
    "gpt-5-pro",
    // The generation's non-reasoning tier.
    "gpt-5-chat-latest",
    // Another vendor's catalog behind the same OpenAI-compatible credential.
    "accounts/fireworks/models/kimi-k3",
  ])("%s is left untouched", (selectedModel) => {
    expect(
      buildOpenAiThinkingProviderOptions({
        ...base,
        selectedModel,
        thinkingEffort: "high",
      }),
    ).toBeUndefined();
  });

  test("carries only the reasoning key, so spreading cannot clobber a sibling", () => {
    // The chat route spreads this into blocks that already set `store`,
    // `reasoningSummary` and `maxCompletionTokens`.
    expect(
      Object.keys(
        buildOpenAiThinkingProviderOptions({
          ...base,
          selectedModel: "gpt-5.2",
        }) ?? {},
      ),
    ).toEqual(["reasoningEffort"]);
  });
});

describe("buildOpenAiThinkingProviderOptions on a self-hosted server", () => {
  test.each([
    "vllm",
    "ollama",
  ])("%s takes the depth verbatim, whatever the model is called", (provider) => {
    // No vendor catalog can place these ids: the operator chose the name.
    expect(
      buildOpenAiThinkingProviderOptions({
        provider,
        selectedModel: "Qwen/Qwen3.8-27B",
        thinkingEffort: "low",
      }),
    ).toEqual({ reasoningEffort: "low" });
  });

  test("an unchosen depth still sends nothing", () => {
    expect(
      buildOpenAiThinkingProviderOptions({
        provider: "vllm",
        selectedModel: "Qwen/Qwen3.8-27B",
        thinkingEffort: null,
      }),
    ).toBeUndefined();
  });

  test("ollama-native is not served here — its wire field is a boolean", () => {
    expect(
      buildOpenAiThinkingProviderOptions({
        provider: "ollama-native",
        selectedModel: "Qwen/Qwen3.8-27B",
        thinkingEffort: "high",
      }),
    ).toBeUndefined();
  });
});
