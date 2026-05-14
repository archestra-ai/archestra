import type AnthropicProvider from "@anthropic-ai/sdk";
import { describe, expect, test, vi } from "vitest";

const {
  mockGetAnthropicWorkloadIdentityBearerTokenProvider,
  mockIsAnthropicWorkloadIdentityEnabled,
} = vi.hoisted(() => ({
  mockGetAnthropicWorkloadIdentityBearerTokenProvider: (() => {
    process.env.ARCHESTRA_DATABASE_URL =
      process.env.ARCHESTRA_DATABASE_URL ??
      "postgres://postgres:postgres@localhost:5432/archestra_test";

    return vi.fn(() => async () => "anthropic-wif-token");
  })(),
  mockIsAnthropicWorkloadIdentityEnabled: vi.fn(() => true),
}));

vi.mock("@/observability", () => ({
  metrics: { llm: { getObservableFetch: vi.fn() } },
}));

vi.mock("@/clients/azure-openai-credentials", () => ({
  getAzureAiFoundryBearerTokenProvider: vi.fn(),
  isAnthropicAzureFoundryEntraIdEnabled: vi.fn(() => false),
}));

vi.mock("@/clients/anthropic-workload-identity", () => ({
  getAnthropicWorkloadIdentityBearerTokenProvider:
    mockGetAnthropicWorkloadIdentityBearerTokenProvider,
  isAnthropicWorkloadIdentityEnabled: mockIsAnthropicWorkloadIdentityEnabled,
}));

import { anthropicAdapterFactory } from "./anthropic";

describe("anthropicAdapterFactory workload identity", () => {
  test("creates a keyless client that injects Anthropic WIF bearer auth", async () => {
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

    const fetch = client._options?.fetch;
    expect(fetch).toBeDefined();

    const upstreamFetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("{}"));

    await fetch?.("https://api.anthropic.com/v1/messages", {
      headers: {
        "anthropic-version": "2023-06-01",
        "x-api-key": "should-not-forward",
      },
    });

    const headers = new Headers(upstreamFetch.mock.calls[0]?.[1]?.headers);
    expect(headers.get("Authorization")).toBe("Bearer anthropic-wif-token");
    expect(headers.get("x-api-key")).toBeNull();
    expect(
      mockGetAnthropicWorkloadIdentityBearerTokenProvider,
    ).toHaveBeenCalledWith("https://api.anthropic.com", undefined);

    upstreamFetch.mockRestore();
  });

  test("keeps explicit API keys on the API key path", () => {
    const client = anthropicAdapterFactory.createClient("sk-ant-api-test", {
      baseUrl: "https://api.anthropic.com",
      defaultHeaders: {},
      source: "api",
    }) as AnthropicProvider & {
      _options?: {
        apiKey?: string | null;
        authToken?: string | null;
        defaultHeaders?: Record<string, string>;
      };
    };

    expect(client._options?.apiKey).toBe("sk-ant-api-test");
    expect(client._options?.authToken).toBeNull();
    expect(client._options?.defaultHeaders?.Authorization).toBeUndefined();
  });
});
