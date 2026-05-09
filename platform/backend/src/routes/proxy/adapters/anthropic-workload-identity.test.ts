import type AnthropicProvider from "@anthropic-ai/sdk";
import { afterEach, describe, expect, test, vi } from "vitest";

vi.mock("@/observability", () => ({
  metrics: { llm: { getObservableFetch: vi.fn() } },
}));

vi.mock("@/clients/azure-openai-credentials", () => ({
  getAzureAiFoundryBearerTokenProvider: vi.fn(),
  isAnthropicAzureFoundryEntraIdEnabled: vi.fn(() => false),
}));

vi.stubEnv(
  "ARCHESTRA_DATABASE_URL",
  "postgresql://archestra:archestra@localhost:5432/archestra_test",
);

const { anthropicAdapterFactory } = await import("./anthropic");

describe("anthropicAdapterFactory Workload Identity Federation", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  test("creates a keyless client that exchanges OIDC identity for Anthropic bearer auth", async () => {
    vi.stubEnv("ARCHESTRA_ANTHROPIC_FEDERATION_RULE_ID", "fdrl_test");
    vi.stubEnv(
      "ARCHESTRA_ANTHROPIC_ORGANIZATION_ID",
      "00000000-0000-0000-0000-000000000000",
    );
    vi.stubEnv("ARCHESTRA_ANTHROPIC_SERVICE_ACCOUNT_ID", "svac_test");
    vi.stubEnv("ARCHESTRA_ANTHROPIC_WORKSPACE_ID", "wrkspc_test");
    vi.stubEnv("ARCHESTRA_ANTHROPIC_IDENTITY_TOKEN", "jwt-from-idp");

    const upstreamFetch = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input) => {
        const url = String(input);
        if (url.endsWith("/v1/oauth/token")) {
          return new Response(
            JSON.stringify({
              access_token: "sk-ant-oat01-token",
              token_type: "Bearer",
              expires_in: 3600,
              scope: "workspace:developer",
            }),
            { headers: { "request-id": "req-token" } },
          );
        }

        return new Response("{}");
      });

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

    await fetch?.("https://api.anthropic.com/v1/messages", {
      headers: { "anthropic-version": "2023-06-01" },
    });

    expect(upstreamFetch).toHaveBeenCalledTimes(2);

    const tokenRequest = upstreamFetch.mock.calls[0];
    expect(tokenRequest?.[0]).toBe("https://api.anthropic.com/v1/oauth/token");
    const tokenHeaders = new Headers(tokenRequest?.[1]?.headers);
    expect(tokenHeaders.get("anthropic-beta")).toContain(
      "oidc-federation-2026-04-01",
    );
    expect(JSON.parse(String(tokenRequest?.[1]?.body))).toMatchObject({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: "jwt-from-idp",
      federation_rule_id: "fdrl_test",
      organization_id: "00000000-0000-0000-0000-000000000000",
      service_account_id: "svac_test",
      workspace_id: "wrkspc_test",
    });

    const messageRequest = upstreamFetch.mock.calls[1];
    const messageHeaders = new Headers(messageRequest?.[1]?.headers);
    expect(messageHeaders.get("Authorization")).toBe(
      "Bearer sk-ant-oat01-token",
    );
    expect(messageHeaders.get("anthropic-beta")).toContain("oauth-2025-04-20");
  });

  test("does not use workload identity when a request supplies an API key", () => {
    vi.stubEnv("ARCHESTRA_ANTHROPIC_FEDERATION_RULE_ID", "fdrl_test");
    vi.stubEnv(
      "ARCHESTRA_ANTHROPIC_ORGANIZATION_ID",
      "00000000-0000-0000-0000-000000000000",
    );
    vi.stubEnv("ARCHESTRA_ANTHROPIC_SERVICE_ACCOUNT_ID", "svac_test");
    vi.stubEnv("ARCHESTRA_ANTHROPIC_IDENTITY_TOKEN", "jwt-from-idp");

    const client = anthropicAdapterFactory.createClient("sk-ant-api-key", {
      baseUrl: "https://api.anthropic.com",
      defaultHeaders: {},
      source: "api",
    }) as AnthropicProvider & {
      _options?: {
        apiKey?: unknown;
        defaultHeaders?: Record<string, string>;
      };
    };

    expect(client._options?.apiKey).toBe("sk-ant-api-key");
    expect(client._options?.defaultHeaders?.Authorization).toBeUndefined();
  });
});
