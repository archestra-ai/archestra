import { describe, expect, test } from "vitest";
import {
  openAiReasoningEffortForEffort,
  supportsOpenAiThinkingEffort,
} from "./openai-models";

describe("supportsOpenAiThinkingEffort", () => {
  test.each([
    // The gpt-5 generations all take the field, tiers and dated snapshots too.
    ["gpt-5", true],
    ["gpt-5-mini", true],
    ["gpt-5-nano", true],
    ["gpt-5-2025-08-07", true],
    ["gpt-5.1", true],
    ["gpt-5.2", true],
    ["gpt-5.4-mini-2026-03-17", true],
    ["gpt-5.5", true],
    ["gpt-5.6", true],
    ["gpt-5.6-sol", true],
    // Codex variants are ordinary reasoning models.
    ["gpt-5-codex", true],
    ["gpt-5.1-codex-max", true],
    ["gpt-5.3-codex-spark", true],
    // The o series, including its pro tier, takes the full range.
    ["o1", true],
    ["o1-pro", true],
    ["o3", true],
    ["o3-mini", true],
    ["o3-pro", true],
    ["o4-mini", true],

    // The gpt-5 pro tier accepts only "high", so there is no depth to choose.
    ["gpt-5-pro", false],
    ["gpt-5-pro-2025-10-06", false],
    ["gpt-5.5-pro", false],
    // Each generation's non-reasoning chat tier rejects the field.
    ["gpt-5-chat-latest", false],
    ["gpt-5.3-chat-latest", false],
    ["chat-latest", false],
    // Search is a retrieval surface with its own request shape.
    ["gpt-5-search-api", false],
    ["gpt-4o-search-preview", false],
    // Shipped before the knob existed.
    ["o1-mini", false],
    // Non-reasoning families 400 on the field.
    ["gpt-4o", false],
    ["gpt-4.1", false],
    ["gpt-4-turbo", false],
    ["gpt-3.5-turbo", false],
    ["gpt-4o-mini", false],
  ])("%s -> effort=%s", (modelId, expected) => {
    expect(supportsOpenAiThinkingEffort(modelId)).toBe(expected);
  });

  test.each([
    // The `openai` provider is an OpenAI-compatible protocol, not a vendor: the
    // same credential serves other catalogs, and none of them takes OpenAI's
    // reasoning_effort.
    "accounts/fireworks/models/gpt-oss-120b",
    "accounts/fireworks/models/deepseek-v4-pro",
    "deepseek-ai/DeepSeek-R1",
    "google/gemma-4-31B-it",
    "deepcogito/cogito-v2-1-671b",
  ])("rejects the vendor-prefixed id %s", (modelId) => {
    expect(supportsOpenAiThinkingEffort(modelId)).toBe(false);
  });

  test("a foreign id carrying a carve-out token stays rejected", () => {
    // Family membership is checked before the carve-outs, so "pro" in an
    // unrelated id cannot fall through to a true.
    expect(supportsOpenAiThinkingEffort("deepseek-v4-pro")).toBe(false);
    expect(supportsOpenAiThinkingEffort("some-model-pro")).toBe(false);
  });

  test("is case-insensitive", () => {
    expect(supportsOpenAiThinkingEffort("GPT-5.2")).toBe(true);
    expect(supportsOpenAiThinkingEffort("GPT-5-Pro")).toBe(false);
  });

  test("covers a generation that has not shipped yet", () => {
    expect(supportsOpenAiThinkingEffort("gpt-5.9-turbo")).toBe(true);
  });
});

describe("openAiReasoningEffortForEffort", () => {
  test.each([
    "low",
    "medium",
    "high",
  ] as const)("%s maps to itself on a reasoning model", (effort) => {
    expect(openAiReasoningEffortForEffort("gpt-5.2", effort)).toBe(effort);
  });

  test.each([
    "gpt-4o",
    "gpt-5-pro",
    "o1-mini",
  ])("sends nothing for %s", (modelId) => {
    expect(openAiReasoningEffortForEffort(modelId, "high")).toBeNull();
  });
});
