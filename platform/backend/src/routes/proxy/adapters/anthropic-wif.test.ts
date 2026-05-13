import type AnthropicProvider from "@anthropic-ai/sdk";
import { describe, expect, test, vi } from "vitest";

vi.mock("@/observability", () => ({
  metrics: { llm: { getObservableFetch: vi.fn() } },
}));

vi.mock("@/clients/azure-openai-credentials", () => ({
  getAzureAiFoundryBearerTokenProvider: vi.fn(
    () => async () => "azure-foundry-token",
  ),
  isAnthropicAzureFoundryEntraIdEnabled: vi.fn(() => false),
}));

const getAnthropicWifCredentialsMock = vi.fn();
vi.mock("@/clients/anthropic-wif-credentials", () => ({
  getAnthropicWifCredentials: (fetchImpl: typeof globalThis.fetch): unknown =>
    getAnthropicWifCredentialsMock(fetchImpl),
}));

import { anthropicAdapterFactory } from "./anthropic";

describe("anthropicAdapterFactory WIF", () => {
  test("creates a WIF-backed client when no API key is provided", () => {
    const mockCredentials = { kind: "anthropic-wif" };
    getAnthropicWifCredentialsMock.mockReturnValueOnce(mockCredentials);

    const client = anthropicAdapterFactory.createClient(undefined, {
      baseUrl: "https://api.anthropic.com",
      defaultHeaders: {},
      source: "api",
    }) as AnthropicProvider & {
      _options?: {
        credentials?: unknown;
      };
    };

    expect(getAnthropicWifCredentialsMock).toHaveBeenCalledTimes(1);
    expect(client._options?.credentials).toEqual(mockCredentials);
  });

  test("prefers explicit API keys over WIF credentials", () => {
    const mockCredentials = { kind: "anthropic-wif" };
    getAnthropicWifCredentialsMock.mockReturnValueOnce(mockCredentials);

    const client = anthropicAdapterFactory.createClient("sk-test", {
      baseUrl: "https://api.anthropic.com",
      defaultHeaders: {},
      source: "api",
    }) as AnthropicProvider & {
      _options?: {
        credentials?: unknown;
        apiKey?: unknown;
      };
    };

    expect(client._options?.apiKey).toBe("sk-test");
    expect(client._options?.credentials).toBeUndefined();
  });
});
