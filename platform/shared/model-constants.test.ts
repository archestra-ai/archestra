import { describe, expect, test } from "vitest";
import {
  getProvidersWithOptionalApiKey,
  isProviderApiKeyOptional,
  isSelfHostedProvider,
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

  test("treats Anthropic as optional only when Workload Identity Federation is enabled", () => {
    expect(isProviderApiKeyOptional({ provider: "anthropic" })).toBe(false);
    expect(
      isProviderApiKeyOptional({
        provider: "anthropic",
        anthropicWifEnabled: true,
      }),
    ).toBe(true);
  });

  test("lists providers with optional API keys", () => {
    expect(getProvidersWithOptionalApiKey()).toEqual(["ollama", "vllm"]);
    expect(
      getProvidersWithOptionalApiKey({ azureEntraIdEnabled: true }),
    ).toEqual(["ollama", "vllm", "azure"]);
    expect(
      getProvidersWithOptionalApiKey({ anthropicWifEnabled: true }),
    ).toEqual(["ollama", "vllm", "anthropic"]);
  });
});

describe("isSelfHostedProvider", () => {
  test("matches only the self-hosted providers", () => {
    expect(isSelfHostedProvider("ollama")).toBe(true);
    expect(isSelfHostedProvider("vllm")).toBe(true);
  });

  test("excludes cloud keyless providers (no per-provider denylist needed)", () => {
    // These are optional-key via runtime flags but are NOT self-hosted, so the
    // Docker-localhost hint must not apply to them.
    expect(isSelfHostedProvider("azure")).toBe(false);
    expect(isSelfHostedProvider("anthropic")).toBe(false);
    expect(isSelfHostedProvider("openai")).toBe(false);
  });
});
