import { afterEach, describe, expect, test, vi } from "vitest";

vi.stubEnv(
  "ARCHESTRA_DATABASE_URL",
  "postgresql://archestra:archestra@localhost:5432/archestra_test",
);

vi.mock("@/clients/azure-openai-credentials", () => ({
  getAzureAiFoundryBearerTokenProvider: vi.fn(),
  isAnthropicAzureFoundryEntraIdEnabled: vi.fn(() => false),
}));

const { fetchAnthropicModels } = await import("./anthropic");

describe("fetchAnthropicModels", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  test("uses Workload Identity Federation when no API key is supplied", async () => {
    vi.stubEnv("ARCHESTRA_ANTHROPIC_FEDERATION_RULE_ID", "fdrl_models_test");
    vi.stubEnv(
      "ARCHESTRA_ANTHROPIC_ORGANIZATION_ID",
      "00000000-0000-0000-0000-000000000000",
    );
    vi.stubEnv("ARCHESTRA_ANTHROPIC_SERVICE_ACCOUNT_ID", "svac_models_test");
    vi.stubEnv("ARCHESTRA_ANTHROPIC_WORKSPACE_ID", "wrkspc_models_test");
    vi.stubEnv("ARCHESTRA_ANTHROPIC_IDENTITY_TOKEN", "jwt-for-model-fetcher");

    const upstreamFetch = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input, init) => {
        const url = String(input);
        if (url.endsWith("/v1/oauth/token")) {
          return new Response(
            JSON.stringify({
              access_token: "sk-ant-oat01-models",
              token_type: "Bearer",
              expires_in: 3600,
              scope: "workspace:developer",
            }),
          );
        }

        expect(url).toBe("https://api.anthropic.com/v1/models?limit=100");
        const headers = new Headers(init?.headers);
        expect(headers.get("Authorization")).toBe("Bearer sk-ant-oat01-models");
        expect(headers.get("anthropic-beta")).toContain("oauth-2025-04-20");
        return new Response(
          JSON.stringify({
            data: [
              {
                id: "claude-sonnet-4-6",
                display_name: "Claude Sonnet 4.6",
                created_at: "2026-05-01T00:00:00Z",
              },
            ],
          }),
        );
      });

    await expect(
      fetchAnthropicModels("", "https://api.anthropic.com"),
    ).resolves.toEqual([
      {
        id: "claude-sonnet-4-6",
        displayName: "Claude Sonnet 4.6",
        provider: "anthropic",
        createdAt: "2026-05-01T00:00:00Z",
      },
    ]);

    expect(upstreamFetch).toHaveBeenCalledTimes(2);
  });
});
