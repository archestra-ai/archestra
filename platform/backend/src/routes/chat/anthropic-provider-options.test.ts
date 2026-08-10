import { describe, expect, test } from "vitest";
import { buildAnthropicProviderOptions } from "./anthropic-provider-options";

const base = {
  provider: "anthropic",
  thinkingEffort: "medium" as const,
};

describe("buildAnthropicProviderOptions", () => {
  test("leaves non-Anthropic turns alone", () => {
    expect(
      buildAnthropicProviderOptions({
        ...base,
        provider: "openai",
        selectedModel: "gpt-5.2",
      }),
    ).toBeUndefined();
  });

  test.each([
    "low",
    "medium",
    "high",
  ] as const)("%s reaches the model unchanged", (thinkingEffort) => {
    expect(
      buildAnthropicProviderOptions({
        ...base,
        selectedModel: "claude-opus-5",
        thinkingEffort,
      }),
    ).toEqual({ effort: thinkingEffort });
  });

  test("auto sends no effort, leaving Anthropic's own default in place", () => {
    // Anthropic defaults to `high`, so any level here — `medium` included —
    // would change what an untouched Claude chat does, and what it costs.
    expect(
      buildAnthropicProviderOptions({
        ...base,
        selectedModel: "claude-opus-5",
        thinkingEffort: null,
      }),
    ).toBeUndefined();
  });

  test.each([
    "claude-sonnet-5",
    "claude-fable-5",
    "claude-mythos-5",
    "claude-opus-5-20260724",
  ])("%s carries a depth", (selectedModel) => {
    expect(buildAnthropicProviderOptions({ ...base, selectedModel })).toEqual({
      effort: "medium",
    });
  });

  test.each([
    // Accept the field but keep thinking off, so a depth would move token
    // spend without producing any reasoning.
    "claude-opus-4-8",
    "claude-opus-4-7",
    "claude-sonnet-4-6",
    // Reject the field outright.
    "claude-sonnet-4-5",
    "claude-haiku-4-5",
  ])("%s is left untouched", (selectedModel) => {
    expect(
      buildAnthropicProviderOptions({
        ...base,
        selectedModel,
        thinkingEffort: "high",
      }),
    ).toBeUndefined();
  });

  test("never writes `thinking`, which would cost the reasoning UI", () => {
    // The AI SDK's `thinking` option has no `display` field, so visible
    // reasoning comes from the fetch wrapper in clients/llm-client.ts — and
    // that wrapper skips any body already declaring `thinking`.
    const options = buildAnthropicProviderOptions({
      ...base,
      selectedModel: "claude-opus-5",
    });
    expect(options).not.toHaveProperty("thinking");
  });
});
