import { describe, expect, test } from "vitest";
import { buildGeminiProviderOptions } from "./gemini-provider-options";

const base = {
  provider: "gemini",
  isGeminiImageModel: false,
  thinkingEffort: "low" as const,
};

describe("buildGeminiProviderOptions", () => {
  test("leaves non-Gemini turns alone", () => {
    expect(
      buildGeminiProviderOptions({
        ...base,
        provider: "openai",
        selectedModel: "gpt-5",
        thinkingEffort: "high",
      }),
    ).toBeUndefined();
  });

  describe("models with a selectable effort", () => {
    test.each([
      // Only the minimal level declines summaries: at minimal there is nothing to show,
      // and the smallest request is the safest one.
      ["low", { thinkingLevel: "minimal" }],
      ["medium", { thinkingLevel: "medium", includeThoughts: true }],
      ["high", { thinkingLevel: "high", includeThoughts: true }],
    ] as const)("%s asks for %o", (thinkingEffort, thinkingConfig) => {
      expect(
        buildGeminiProviderOptions({
          ...base,
          selectedModel: "gemini-3.6-flash",
          thinkingEffort,
        }),
      ).toEqual({ thinkingConfig });
    });

    test("an explicit level makes summaries safe on flash-lite", () => {
      // supportsGeminiThoughtSummaries reports false for flash-lite because its
      // thinking is off *by default* — an explicit level overrides that.
      expect(
        buildGeminiProviderOptions({
          ...base,
          selectedModel: "gemini-3.5-flash-lite",
          thinkingEffort: "high",
        }),
      ).toEqual({
        thinkingConfig: { thinkingLevel: "high", includeThoughts: true },
      });
    });

    test.each([
      "low",
      "medium",
      "high",
    ] as const)("never pairs a budget with a level (%s)", (thinkingEffort) => {
      // Sending thinkingBudget and thinkingLevel together is a 400.
      const options = buildGeminiProviderOptions({
        ...base,
        selectedModel: "gemini-3.5-flash",
        thinkingEffort,
      });
      expect(options?.thinkingConfig).toBeDefined();
      expect(options?.thinkingConfig).not.toHaveProperty("thinkingBudget");
    });
  });

  describe("models without a selectable effort", () => {
    test.each([
      "low",
      "medium",
      "high",
    ] as const)("a thinks-by-default model still gets summaries and no level (%s)", (thinkingEffort) => {
      // The stored effort must not leak onto a model that cannot honor it.
      expect(
        buildGeminiProviderOptions({
          ...base,
          selectedModel: "gemini-2.5-pro",
          thinkingEffort,
        }),
      ).toEqual({ thinkingConfig: { includeThoughts: true } });
    });

    test("a model with thinking off by default gets no options at all", () => {
      expect(
        buildGeminiProviderOptions({
          ...base,
          selectedModel: "gemini-2.5-flash-lite",
          thinkingEffort: "high",
        }),
      ).toBeUndefined();
    });

    test("gemma gets no options at all", () => {
      expect(
        buildGeminiProviderOptions({
          ...base,
          selectedModel: "gemma-4-31b-it",
          thinkingEffort: "high",
        }),
      ).toBeUndefined();
    });
  });

  describe("image models", () => {
    test.each([
      "low",
      "medium",
      "high",
    ] as const)("keep their response modalities and take no thinking config (%s)", (thinkingEffort) => {
      // A separate thinking block assigned to the same `google` key would
      // drop responseModalities and break image output.
      expect(
        buildGeminiProviderOptions({
          ...base,
          selectedModel: "gemini-3.1-flash-image-preview",
          isGeminiImageModel: true,
          thinkingEffort,
        }),
      ).toEqual({ responseModalities: ["TEXT", "IMAGE"] });
    });
  });
});
