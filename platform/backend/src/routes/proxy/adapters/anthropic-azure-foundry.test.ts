import type AnthropicProvider from "@anthropic-ai/sdk";
import { describe, expect, test, vi } from "vitest";

const mockIsAnthropicAzureFoundryEntraIdEnabled = vi.hoisted(() =>
  vi.fn(() => true),
);
const mockIsAnthropicWorkloadIdentityEnabled = vi.hoisted(() =>
  vi.fn(() => false),
);
const mockCreateAnthropicWorkloadIdentityFetch = vi.hoisted(() =>
  vi.fn((fetch?: typeof globalThis.fetch) => fetch ?? globalThis.fetch),
);

vi.mock("@/observability", () => ({
  metrics: { llm: { getObservableFetch: vi.fn() } },
}));

vi.mock("@/clients/azure-openai-credentials", () => ({
  getAzureAiFoundryBearerTokenProvider: vi.fn(
    () => async () => "azure-foundry-token",
  ),
  isAnthropicAzureFoundryEntraIdEnabled:
    mockIsAnthropicAzureFoundryEntraIdEnabled,
}));

vi.mock("@/clients/anthropic-workload-identity", () => ({
  createAnthropicWorkloadIdentityFetch:
    mockCreateAnthropicWorkloadIdentityFetch,
  isAnthropicWorkloadIdentityEnabled: mockIsAnthropicWorkloadIdentityEnabled,
}));

import { anthropicAdapterFactory } from "./anthropic";

describe("anthropicAdapterFactory Azure Foundry", () => {
  test("creates a keyless client that injects Entra ID bearer auth", async () => {
    const client = anthropicAdapterFactory.createClient(undefined, {
      baseUrl: "https://resource.services.ai.azure.com/anthropic",
      defaultHeaders: {},
      source: "api",
    }) as AnthropicProvider & {
      _options?: {
        defaultHeaders?: Record<string, string>;
        fetch?: typeof globalThis.fetch;
      };
    };

    expect(client._options?.defaultHeaders?.Authorization).toBe(
      "Bearer <entra-id-managed>",
    );

    const fetch = client._options?.fetch;
    expect(fetch).toBeDefined();

    const upstreamFetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("{}"));

    await fetch?.(
      "https://resource.services.ai.azure.com/anthropic/v1/messages",
      {
        headers: { "anthropic-version": "2023-06-01" },
      },
    );

    const headers = new Headers(upstreamFetch.mock.calls[0]?.[1]?.headers);
    expect(headers.get("Authorization")).toBe("Bearer azure-foundry-token");

    upstreamFetch.mockRestore();
  });

  test("creates a keyless client that injects Anthropic workload identity auth", () => {
    mockIsAnthropicAzureFoundryEntraIdEnabled.mockReturnValue(false);
    mockIsAnthropicWorkloadIdentityEnabled.mockReturnValue(true);
    mockCreateAnthropicWorkloadIdentityFetch.mockClear();

    const client = anthropicAdapterFactory.createClient(undefined, {
      baseUrl: "https://api.anthropic.com",
      defaultHeaders: {},
      source: "api",
    }) as AnthropicProvider & {
      _options?: {
        defaultHeaders?: Record<string, string>;
        fetch?: typeof globalThis.fetch;
      };
    };

    expect(client._options?.defaultHeaders?.Authorization).toBe(
      "Bearer <anthropic-wif-managed>",
    );
    expect(mockCreateAnthropicWorkloadIdentityFetch).toHaveBeenCalled();

    mockIsAnthropicAzureFoundryEntraIdEnabled.mockReturnValue(true);
    mockIsAnthropicWorkloadIdentityEnabled.mockReturnValue(false);
  });
});
