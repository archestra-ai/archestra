import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { anthropicWorkloadIdentity } from "@/clients/anthropic-workload-identity";
import config, { type AnthropicWifConfig } from "@/config";
import { fetchAnthropicModels } from "./anthropic";

// No module mocks: drive the real WIF client + fetcher through the fetch
// boundary and real config, keeping this file in the fast vitest project.

const WIF_CONFIG: AnthropicWifConfig = {
  federationRuleId: "fdrl_test",
  organizationId: "00000000-0000-0000-0000-000000000000",
  serviceAccountId: "svac_test",
  identityToken: "jwt-inline",
};

const originalWif = config.llm.anthropic.wif;

function stubAnthropicFetch() {
  const fetchMock = vi.fn(
    async (
      input: RequestInfo | URL,
      _init?: RequestInit,
    ): Promise<Response> => {
      const url = String(input);
      if (url.endsWith("/v1/oauth/token")) {
        return new Response(
          JSON.stringify({
            access_token: "sk-ant-oat01-test",
            token_type: "Bearer",
            expires_in: 3600,
          }),
          { status: 200 },
        );
      }
      if (url.includes("/v1/models")) {
        return new Response(
          JSON.stringify({
            data: [
              {
                id: "claude-sonnet-4-6",
                display_name: "Claude Sonnet 4.6",
                created_at: "2026-01-01T00:00:00Z",
              },
            ],
          }),
          { status: 200 },
        );
      }
      throw new Error(`unexpected request: ${url}`);
    },
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/** The headers the fetcher sent on the `/v1/models` request. */
function modelsRequestHeaders(
  fetchMock: ReturnType<typeof stubAnthropicFetch>,
): Record<string, string> {
  const call = fetchMock.mock.calls.find((c) =>
    String(c[0]).includes("/v1/models"),
  );
  return (call?.[1]?.headers ?? {}) as Record<string, string>;
}

describe("fetchAnthropicModels", () => {
  beforeEach(() => {
    anthropicWorkloadIdentity.resetForTests();
    config.llm.anthropic.wif = null;
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    vi.stubEnv("ANTHROPIC_AUTH_TOKEN", "");
  });

  afterEach(() => {
    anthropicWorkloadIdentity.resetForTests();
    config.llm.anthropic.wif = originalWif;
  });

  test("uses a federated bearer token for keyless fetches when WIF is enabled", async () => {
    config.llm.anthropic.wif = { ...WIF_CONFIG };
    const fetchMock = stubAnthropicFetch();

    await expect(
      fetchAnthropicModels("", "https://api.anthropic.com"),
    ).resolves.toMatchObject([
      {
        id: "claude-sonnet-4-6",
        displayName: "Claude Sonnet 4.6",
        provider: "anthropic",
      },
    ]);

    expect(modelsRequestHeaders(fetchMock)).toEqual({
      Authorization: "Bearer sk-ant-oat01-test",
      "anthropic-version": "2023-06-01",
    });
  });

  test("an explicit API key takes precedence over WIF", async () => {
    config.llm.anthropic.wif = { ...WIF_CONFIG };
    const fetchMock = stubAnthropicFetch();

    await fetchAnthropicModels("sk-ant-explicit", "https://api.anthropic.com");

    expect(modelsRequestHeaders(fetchMock)).toEqual({
      "x-api-key": "sk-ant-explicit",
      "anthropic-version": "2023-06-01",
    });
    // No token exchange should have happened.
    expect(
      fetchMock.mock.calls.some((c) =>
        String(c[0]).endsWith("/v1/oauth/token"),
      ),
    ).toBe(false);
  });

  test("falls back to an empty x-api-key when no auth method is available", async () => {
    const fetchMock = stubAnthropicFetch();

    await fetchAnthropicModels("", "https://api.anthropic.com");

    expect(modelsRequestHeaders(fetchMock)).toEqual({
      "x-api-key": "",
      "anthropic-version": "2023-06-01",
    });
  });
});
