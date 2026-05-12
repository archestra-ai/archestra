import type AnthropicProvider from "@anthropic-ai/sdk";
import { describe, expect, test, vi } from "vitest";

process.env.ARCHESTRA_DATABASE_URL = "postgres://test:test@localhost:5432/test";
process.env.ARCHESTRA_ANTHROPIC_WIF_ENABLED = "true";
process.env.ARCHESTRA_ANTHROPIC_WIF_FEDERATION_RULE_ID = "fdrl_test";
process.env.ARCHESTRA_ANTHROPIC_WIF_ORGANIZATION_ID = "org_test";
process.env.ARCHESTRA_ANTHROPIC_WIF_SERVICE_ACCOUNT_ID = "svac_test";
process.env.ARCHESTRA_ANTHROPIC_WIF_WORKSPACE_ID = "wrkspc_test";
process.env.ARCHESTRA_ANTHROPIC_WIF_IDENTITY_TOKEN_FILE = "/tmp/identity-token";

const metricFetch = vi.fn();

vi.mock("@/observability", () => ({
  metrics: { llm: { getObservableFetch: vi.fn(() => metricFetch) } },
}));

vi.mock("@/clients/azure-openai-credentials", () => ({
  getAzureAiFoundryBearerTokenProvider: vi.fn(),
  isAnthropicAzureFoundryEntraIdEnabled: vi.fn(() => false),
}));

vi.mock("@/clients/anthropic-wif-credentials", () => ({
  isAnthropicWifEnabled: vi.fn(() => true),
  createAnthropicWifFetch: vi.fn((baseFetch?: typeof globalThis.fetch) => {
    const fetchFn = baseFetch ?? globalThis.fetch;
    return async (input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      headers.set("Authorization", "Bearer wif-token");
      return fetchFn(input, { ...init, headers });
    };
  }),
}));

vi.mock("node:fs", () => ({
  readFileSync: vi.fn(() => "identity-jwt"),
}));

import { anthropicAdapterFactory } from "./anthropic";

describe("anthropicAdapterFactory WIF", () => {
  test("creates a keyless client that injects Anthropic WIF bearer auth", async () => {
    metricFetch.mockResolvedValue(new Response("{}"));

    const client = anthropicAdapterFactory.createClient(undefined, {
      baseUrl: "https://api.anthropic.com",
      defaultHeaders: {},
      agent: { id: "agent-id" } as never,
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

    await fetch?.("https://api.anthropic.com/v1/messages", {
      headers: { "anthropic-version": "2023-06-01" },
    });

    const requestCall = metricFetch.mock.calls[0];
    const headers = new Headers(requestCall?.[1]?.headers);
    expect(headers.get("Authorization")).toBe("Bearer wif-token");
  });
});
