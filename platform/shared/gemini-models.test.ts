import { describe, expect, test } from "vitest";
import {
  isLegacyGeminiModel,
  isUsableGeminiCatalogModel,
  supportsGeminiThoughtSummaries,
} from "./gemini-models";

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
    ["gemini-embedding-2-preview", true],
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
