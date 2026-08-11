import { describe, expect, test } from "vitest";
import {
  geminiThinkingConfigForEffort,
  isLegacyGeminiModel,
  isUsableGeminiCatalogModel,
  supportsGeminiThinkingEffort,
  supportsGeminiThoughtSummaries,
} from "./gemini-models";
import { THINKING_EFFORTS } from "./thinking-effort";

describe("isUsableGeminiCatalogModel", () => {
  test.each([
    // Gemini chat models >= 2.5 are kept.
    ["gemini-2.5-pro", true],
    ["gemini-2.5-flash", true],
    ["gemini-2.5-pro-preview-06-05", true],
    ["gemini-2.10-flash", true],
    ["gemini-3-pro", true],
    ["gemini-3.1-pro-preview", true],
    ["gemini-3.5-flash", true],
    // First-class Gemini embeddings are kept regardless of version.
    ["gemini-embedding-001", true],
    ["gemini-embedding-2", true],
    ["gemini-embedding-2-preview", false],
    // Recent gemma is kept; older gemma falls below the min version.
    ["gemma-3-27b-it", true],
    ["gemma-3n-e4b-it", true],
    ["gemma-2-9b-it", false],
    ["gemma-1.1-7b-it", false],
    // Pre-2.5 Gemini is dropped.
    ["gemini-2.0-flash", false],
    ["gemini-1.5-pro", false],
    ["gemini-1.0-pro-vision-latest", false],
    ["gemini-pro", false],
    ["gemini-pro-vision", false],
    // Non-text output families are dropped.
    ["gemini-2.5-flash-preview-tts", false],
    ["gemini-2.5-flash-image", false],
    ["gemini-2.0-flash-live-001", false],
    ["gemini-live-2.5-flash-native-audio", false],
    // Unbranded / non-Gemini families are dropped.
    ["learnlm-2.0-flash-experimental", false],
    ["aqa", false],
    ["chat-bison-001", false],
    ["embedding-001", false],
    ["text-embedding-004", false],
  ])("%s -> keep=%s", (modelId, expected) => {
    expect(isUsableGeminiCatalogModel(modelId)).toBe(expected);
  });

  test("is case-insensitive", () => {
    expect(isUsableGeminiCatalogModel("Gemini-2.5-Pro")).toBe(true);
    expect(isUsableGeminiCatalogModel("GEMINI-1.5-PRO")).toBe(false);
  });
});

describe("supportsGeminiThoughtSummaries", () => {
  test.each([
    // Gemini chat models >= 2.5 think by default.
    ["gemini-2.5-pro", true],
    ["gemini-2.5-flash", true],
    ["gemini-2.5-pro-preview-06-05", true],
    ["gemini-3-pro-preview", true],
    ["gemini-3-flash-preview", true],
    ["gemini-3.5-flash", true],
    // flash-lite has thinking off by default; bare includeThoughts is a 400.
    ["gemini-2.5-flash-lite", false],
    ["gemini-3.5-flash-lite", false],
    // gemma has no thinking support.
    ["gemma-3-27b-it", false],
    // Pre-thinking generations.
    ["gemini-2.0-flash", false],
    ["gemini-1.5-pro", false],
    // Non-text output and embedding variants.
    ["gemini-2.5-flash-image", false],
    ["gemini-2.5-flash-preview-tts", false],
    ["gemini-embedding-001", false],
    // Unversioned ids.
    ["gemini-pro", false],
  ])("%s -> thoughts=%s", (modelId, expected) => {
    expect(supportsGeminiThoughtSummaries(modelId)).toBe(expected);
  });

  test("is case-insensitive", () => {
    expect(supportsGeminiThoughtSummaries("Gemini-2.5-Pro")).toBe(true);
  });
});

describe("supportsGeminiThinkingEffort", () => {
  test.each([
    // The 3.x line takes a thinkingLevel, Pro included.
    ["gemini-3.6-flash", true],
    ["gemini-3.5-flash", true],
    ["gemini-3.5-flash-lite", true],
    ["gemini-3.1-flash-lite", true],
    ["gemini-3-flash-preview", true],
    ["gemini-3.1-pro-preview", true],
    ["gemini-3-pro-preview", true],
    // 2.5 takes a numeric budget, which cannot be paired with a level.
    ["gemini-2.5-flash", false],
    ["gemini-2.5-flash-lite", false],
    ["gemini-2.5-pro", false],
    // Non-text variants and non-Gemini families.
    ["gemini-3.1-flash-image-preview", false],
    ["gemini-3.5-flash-preview-tts", false],
    ["gemma-4-31b-it", false],
    ["gemini-embedding-001", false],
    ["gpt-5", false],
    // Unversioned ids.
    ["gemini-flash-latest", false],
  ])("%s -> effort=%s", (modelId, expected) => {
    expect(supportsGeminiThinkingEffort(modelId)).toBe(expected);
  });

  test("is case-insensitive", () => {
    expect(supportsGeminiThinkingEffort("Gemini-3.6-Flash")).toBe(true);
  });

  test("does not regress once a 3.10 generation ships", () => {
    expect(supportsGeminiThinkingEffort("gemini-3.10-flash")).toBe(true);
  });
});

describe("geminiThinkingConfigForEffort", () => {
  test.each([
    // Flash can skip reasoning outright, so "low" means minimal there.
    ["gemini-3.6-flash", "low", "minimal"],
    ["gemini-3.6-flash", "medium", "medium"],
    ["gemini-3.6-flash", "high", "high"],
    // Pro always reasons and floors at "low" — asking for minimal is rejected,
    // so "low" means the shallowest it will go.
    ["gemini-3.1-pro-preview", "low", "low"],
    ["gemini-3.1-pro-preview", "medium", "medium"],
    ["gemini-3.1-pro-preview", "high", "high"],
  ] as const)("%s at %s asks for %s", (modelId, effort, level) => {
    expect(geminiThinkingConfigForEffort(modelId, effort)).toEqual({
      thinkingLevel: level,
    });
  });

  test.each(
    THINKING_EFFORTS,
  )("returns null for a model without thinking levels (%s)", (effort) => {
    expect(geminiThinkingConfigForEffort("gemini-2.5-pro", effort)).toBeNull();
    expect(geminiThinkingConfigForEffort("gpt-5", effort)).toBeNull();
  });

  test("never emits a thinkingBudget alongside a thinkingLevel", () => {
    // Sending both in one request is a 400.
    for (const effort of THINKING_EFFORTS) {
      const config = geminiThinkingConfigForEffort("gemini-3.5-flash", effort);
      expect(config).not.toBeNull();
      expect(config).not.toHaveProperty("thinkingBudget");
    }
  });
});

describe("isLegacyGeminiModel", () => {
  test.each([
    // <= 3.0 is "old".
    ["gemini-2.5-pro", true],
    ["gemini-2.5-flash", true],
    ["gemini-2.10-flash", true],
    ["gemini-3-pro", true],
    ["gemma-3-27b-it", true],
    ["gemma-3n-e4b-it", true],
    // > 3.0 is current.
    ["gemini-3.1-pro-preview", false],
    ["gemini-3.5-flash", false],
    // Embeddings are never badged.
    ["gemini-embedding-001", false],
    ["gemini-embedding-2-preview", false],
    // Unparsable / unbranded ids are not badged.
    ["gemini-pro", false],
    ["aqa", false],
  ])("%s -> legacy=%s", (modelId, expected) => {
    expect(isLegacyGeminiModel(modelId)).toBe(expected);
  });
});
