import { describe, expect, test } from "vitest";
import {
  getProvidersWithOptionalApiKey,
  isProviderApiKeyOptional,
  requiresOpenAiResponsesApi,
} from "./model-constants";

describe("requiresOpenAiResponsesApi", () => {
  test("matches pro reasoning models, including dated snapshots", () => {
    expect(requiresOpenAiResponsesApi("gpt-5.5-pro")).toBe(true);
    expect(requiresOpenAiResponsesApi("gpt-5.5-pro-2026-01-01")).toBe(true);
    expect(requiresOpenAiResponsesApi("o3-pro")).toBe(true);
  });

  test("does not match chat-completions models", () => {
    expect(requiresOpenAiResponsesApi("gpt-5.5")).toBe(false);
    expect(requiresOpenAiResponsesApi("gpt-4o")).toBe(false);
    expect(requiresOpenAiResponsesApi("babbage-002")).toBe(false);
  });
});

describe("provider API key optional helpers", () => {
  test("treats self-hosted providers as optional", () => {
    expect(isProviderApiKeyOptional({ provider: "ollama" })).toBe(true);
    expect(isProviderApiKeyOptional({ provider: "vllm" })).toBe(true);
  });

  test("treats Azure as optional only when Entra ID is enabled", () => {
    expect(isProviderApiKeyOptional({ provider: "azure" })).toBe(false);
    expect(
      isProviderApiKeyOptional({
        provider: "azure",
        azureEntraIdEnabled: false,
      }),
    ).toBe(false);
    expect(
      isProviderApiKeyOptional({
        provider: "azure",
        azureEntraIdEnabled: true,
      }),
    ).toBe(true);
  });

  test("lists providers with optional API keys", () => {
    expect(getProvidersWithOptionalApiKey()).toEqual(["ollama", "vllm"]);
    expect(
      getProvidersWithOptionalApiKey({ azureEntraIdEnabled: true }),
    ).toEqual(["ollama", "vllm", "azure"]);
  });
});
