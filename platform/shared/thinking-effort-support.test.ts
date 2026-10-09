import { describe, expect, test } from "vitest";
import {
  modelSupportsThinkingEffort,
  supportsThinkingEffort,
} from "./thinking-effort-support";

describe("supportsThinkingEffort", () => {
  test.each([
    ["gemini", "gemini-3.6-flash", true],
    ["gemini", "gemini-2.5-flash", false],
    ["openai", "gpt-5.2", true],
    ["openai", "gpt-4o", false],
    ["anthropic", "claude-opus-5", true],
    ["anthropic", "claude-haiku-4-5", false],
  ])("%s/%s -> %s", (provider, modelId, expected) => {
    expect(supportsThinkingEffort(provider, modelId)).toBe(expected);
  });

  test("a model id alone never decides it — the provider gates first", () => {
    // The same id under the wrong provider speaks a different dialect, so the
    // control must not appear for it.
    expect(supportsThinkingEffort("anthropic", "gpt-5.2")).toBe(false);
    expect(supportsThinkingEffort("openai", "claude-opus-5")).toBe(false);
    expect(supportsThinkingEffort("gemini", "gpt-5.2")).toBe(false);
  });

  test.each([
    "bedrock",
    "azure",
    "github-copilot",
    "ollama-native",
    "xai",
    "",
  ])("%s is out until its dialect is wired", (provider) => {
    // Bedrock and Copilot serve some of the very same models, so the false
    // here is the provider's doing, not the id's.
    expect(supportsThinkingEffort(provider, "claude-opus-5")).toBe(false);
    expect(supportsThinkingEffort(provider, "gpt-5.2")).toBe(false);
  });
});

describe("modelSupportsThinkingEffort", () => {
  test("a self-hosted model is decided by its row, not its id", () => {
    // The same weights under a name no rule could recognize: only the row says
    // whether this deployment reasons.
    expect(
      modelSupportsThinkingEffort({
        provider: "vllm",
        modelId: "Qwen/Qwen3.8-27B",
        supportsReasoningEffort: true,
      }),
    ).toBe(true);
    expect(
      modelSupportsThinkingEffort({
        provider: "ollama",
        modelId: "ops-team-finetune:latest",
        supportsReasoningEffort: true,
      }),
    ).toBe(true);
  });

  test.each([
    false,
    null,
    undefined,
  ])("a self-hosted row of %s keeps the control hidden", (supportsReasoningEffort) => {
    // Only `true` opens it: an unwanted depth is an error on this class of
    // server, while a missed one leaves the composer as it was.
    expect(
      modelSupportsThinkingEffort({
        provider: "vllm",
        modelId: "Qwen/Qwen3.8-27B",
        supportsReasoningEffort,
      }),
    ).toBe(false);
  });

  test("ollama-native stays out even when the model thinks", () => {
    // Its wire field is a boolean, so all three depths would be one behavior.
    expect(
      modelSupportsThinkingEffort({
        provider: "ollama-native",
        modelId: "Qwen/Qwen3.8-27B",
        supportsReasoningEffort: true,
      }),
    ).toBe(false);
  });

  test("an OpenRouter model is decided by its row, not its id", () => {
    // Its ids carry a vendor prefix the id rules would otherwise recognize, but
    // what OpenRouter serves under that name is its own catalog's business —
    // the row carries what its `/models` response reported.
    expect(
      modelSupportsThinkingEffort({
        provider: "openrouter",
        modelId: "deepseek/deepseek-r1",
        supportsReasoningEffort: true,
      }),
    ).toBe(true);
    // A reasoning-capable vendor id is not enough on its own.
    expect(
      modelSupportsThinkingEffort({
        provider: "openrouter",
        modelId: "openai/gpt-5.2",
        supportsReasoningEffort: false,
      }),
    ).toBe(false);
  });

  test.each([
    false,
    null,
    undefined,
  ])("an OpenRouter row of %s keeps the control hidden", (supportsReasoningEffort) => {
    expect(
      modelSupportsThinkingEffort({
        provider: "openrouter",
        modelId: "openai/gpt-4o",
        supportsReasoningEffort,
      }),
    ).toBe(false);
  });

  test("a vendor model ignores the column and keeps its id rule", () => {
    // A wrong row must not be able to switch the control on for a model whose
    // vendor would reject the field, nor off for one that takes it.
    expect(
      modelSupportsThinkingEffort({
        provider: "openai",
        modelId: "gpt-4o",
        supportsReasoningEffort: true,
      }),
    ).toBe(false);
    expect(
      modelSupportsThinkingEffort({
        provider: "anthropic",
        modelId: "claude-opus-5",
        supportsReasoningEffort: false,
      }),
    ).toBe(true);
  });
});
