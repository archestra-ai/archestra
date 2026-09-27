import { describe, expect, test } from "vitest";
import {
  buildDualLlmCallSettings,
  DUAL_LLM_MAX_OUTPUT_TOKENS,
} from "./dual-llm-call-settings";

const NO_KEY = { apiKey: undefined };

describe("buildDualLlmCallSettings", () => {
  test("always caps output tokens, whatever the provider", () => {
    for (const provider of [
      "openai",
      "anthropic",
      "deepseek",
      "ollama",
    ] as const) {
      expect(
        buildDualLlmCallSettings({ provider, modelName: "any", ...NO_KEY })
          .maxOutputTokens,
      ).toBe(DUAL_LLM_MAX_OUTPUT_TOKENS);
    }
  });

  test("deepseek, zhipuai, and minimax get a thinking disable", () => {
    for (const provider of ["deepseek", "zhipuai", "minimax"] as const) {
      const settings = buildDualLlmCallSettings({
        provider,
        modelName: "whatever",
        ...NO_KEY,
      });
      expect(settings.providerOptions?.[provider]).toEqual({
        thinking: { type: "disabled" },
      });
    }
  });

  test("anthropic rides the thinking-off marker header, not providerOptions", () => {
    const settings = buildDualLlmCallSettings({
      provider: "anthropic",
      modelName: "claude-sonnet-5",
      ...NO_KEY,
    });
    expect(settings.providerOptions).toBeUndefined();
    expect(settings.headers).toEqual({
      "x-archestra-anthropic-thinking-off": "1",
    });
  });

  describe("openai effort ladder", () => {
    const effortFor = (modelName: string, apiKey?: string) =>
      buildDualLlmCallSettings({ provider: "openai", modelName, apiKey })
        .providerOptions?.openai?.reasoningEffort;

    test("gpt-5.x generations hard-disable with none", () => {
      expect(effortFor("gpt-5.2")).toBe("none");
      expect(effortFor("gpt-5.6-sol")).toBe("none");
    });

    test("gpt-5 floors at minimal, o-series at low", () => {
      expect(effortFor("gpt-5")).toBe("minimal");
      expect(effortFor("gpt-5-codex")).toBe("minimal");
      expect(effortFor("o3")).toBe("low");
      expect(effortFor("o4-mini")).toBe("low");
      expect(effortFor("o3-pro")).toBe("low");
    });

    test("non-reasoning models and gpt-5-pro get no knob", () => {
      // The chat transport emits reasoning_effort unconditionally, so a knob
      // on gpt-4o would 400; gpt-5-pro accepts only "high".
      expect(effortFor("gpt-4o")).toBeUndefined();
      expect(effortFor("gpt-4.1")).toBeUndefined();
      expect(effortFor("gpt-5-chat")).toBeUndefined();
      expect(effortFor("gpt-5-pro")).toBeUndefined();
    });

    test("a Codex subscription credential floors at minimal (translator coerces none to medium)", () => {
      expect(effortFor("gpt-5.2", "chatgpt-oauth:whatever")).toBe("minimal");
    });
  });

  test("github-copilot only sends the knob for OpenAI reasoning ids", () => {
    const optionsFor = (modelName: string) =>
      buildDualLlmCallSettings({
        provider: "github-copilot",
        modelName,
        ...NO_KEY,
      }).providerOptions;
    expect(optionsFor("claude-sonnet-4")).toBeUndefined();
    expect(optionsFor("gpt-4o")).toBeUndefined();
    expect(optionsFor("gpt-5")).toEqual({
      openai: { reasoningEffort: "minimal" },
    });
  });

  describe("gemini generations", () => {
    const configFor = (modelName: string) =>
      buildDualLlmCallSettings({ provider: "gemini", modelName, ...NO_KEY })
        .providerOptions?.google?.thinkingConfig;

    test("2.5 flash disables outright, 2.5 pro floors at the budget minimum", () => {
      expect(configFor("gemini-2.5-flash")).toEqual({ thinkingBudget: 0 });
      expect(configFor("gemini-2.5-pro")).toEqual({ thinkingBudget: 128 });
    });

    test("3.x uses the level floor; gemma and flash-lite get nothing", () => {
      expect(configFor("gemini-3.6-flash")).toEqual({ thinkingLevel: "low" });
      expect(configFor("gemma-3-27b-it")).toBeUndefined();
      expect(configFor("gemini-2.5-flash-lite")).toBeUndefined();
    });
  });

  test("xai gates on grok-3-mini; grok-4 class gets nothing", () => {
    expect(
      buildDualLlmCallSettings({
        provider: "xai",
        modelName: "grok-4.3",
        ...NO_KEY,
      }).providerOptions,
    ).toBeUndefined();
    expect(
      buildDualLlmCallSettings({
        provider: "xai",
        modelName: "grok-3-mini",
        ...NO_KEY,
      }).providerOptions,
    ).toEqual({ xai: { reasoningEffort: "low" } });
  });

  test("kimi k3 floors at low effort, other kimi models disable", () => {
    expect(
      buildDualLlmCallSettings({
        provider: "kimi",
        modelName: "kimi-k3",
        ...NO_KEY,
      }).providerOptions,
    ).toEqual({ kimi: { reasoningEffort: "low" } });
    expect(
      buildDualLlmCallSettings({
        provider: "kimi",
        modelName: "kimi-k2.6",
        ...NO_KEY,
      }).providerOptions,
    ).toEqual({ kimi: { thinking: { type: "disabled" } } });
  });

  test("bedrock injects native thinking config for claude ids only", () => {
    expect(
      buildDualLlmCallSettings({
        provider: "bedrock",
        modelName: "us.anthropic.claude-sonnet-5-v1:0",
        ...NO_KEY,
      }).providerOptions,
    ).toEqual({
      bedrock: {
        additionalModelRequestFields: { thinking: { type: "disabled" } },
      },
    });
    // Fable/Mythos-class ids cannot disable; effort floor instead.
    expect(
      buildDualLlmCallSettings({
        provider: "bedrock",
        modelName: "anthropic.claude-fable-5-v1:0",
        ...NO_KEY,
      }).providerOptions,
    ).toEqual({ bedrock: { reasoningConfig: { maxReasoningEffort: "low" } } });
    // Non-Anthropic models reject the unknown field.
    expect(
      buildDualLlmCallSettings({
        provider: "bedrock",
        modelName: "amazon.nova-pro-v1:0",
        ...NO_KEY,
      }).providerOptions,
    ).toBeUndefined();
  });

  test("ollama-native caps via options.num_predict and never touches think", () => {
    const settings = buildDualLlmCallSettings({
      provider: "ollama-native",
      modelName: "qwen3:32b",
      ...NO_KEY,
    });
    expect(settings.providerOptions).toEqual({
      ollama: { options: { num_predict: DUAL_LLM_MAX_OUTPUT_TOKENS } },
    });
  });

  test("providers with no reachable knob get only the cap", () => {
    for (const provider of [
      "ollama",
      "perplexity",
      "mistral",
      "cohere",
      "archestra",
      "microsoft-365-copilot",
    ] as const) {
      const settings = buildDualLlmCallSettings({
        provider,
        modelName: "whatever",
        ...NO_KEY,
      });
      expect(settings.providerOptions).toBeUndefined();
      expect(settings.headers).toBeUndefined();
    }
  });
});
