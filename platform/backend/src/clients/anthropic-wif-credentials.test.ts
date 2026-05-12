import { describe, expect, test, vi } from "vitest";

vi.mock("node:fs", () => ({
  readFileSync: vi.fn(() => "identity-jwt"),
}));

vi.mock("@/config", () => ({
  default: {
    llm: {
      anthropic: {
        baseUrl: "https://api.anthropic.com",
        wif: {
          enabled: true,
          federationRuleId: "fdrl_test",
          organizationId: "org_test",
          serviceAccountId: "svac_test",
          workspaceId: "wrkspc_test",
          identityTokenFile: "/tmp/identity-token",
        },
      },
    },
  },
}));

describe("anthropic-wif-credentials", () => {
  test("reports WIF as enabled from config", async () => {
    const { isAnthropicWifEnabled } = await import(
      "./anthropic-wif-credentials"
    );
    expect(isAnthropicWifEnabled()).toBe(true);
  });

  test("exchanges token and reuses cache before expiry", async () => {
    vi.resetModules();
    const fetchSpy = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          access_token: "wif-access-token",
          token_type: "Bearer",
          expires_in: 3600,
        }),
        { status: 200 },
      );
    });

    const { getAnthropicWifAccessToken } = await import(
      "./anthropic-wif-credentials"
    );

    const first = await getAnthropicWifAccessToken(fetchSpy);
    const second = await getAnthropicWifAccessToken(fetchSpy);

    expect(first).toBe("wif-access-token");
    expect(second).toBe("wif-access-token");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  test("wraps fetch and injects bearer token", async () => {
    vi.resetModules();

    const fetchSpy = vi.fn(
      async (input: RequestInfo | URL, _init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/v1/oauth/token")) {
          return new Response(
            JSON.stringify({
              access_token: "wif-access-token",
              token_type: "Bearer",
              expires_in: 3600,
            }),
            { status: 200 },
          );
        }
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      },
    );

    const { createAnthropicWifFetch } = await import(
      "./anthropic-wif-credentials"
    );
    const wrappedFetch = createAnthropicWifFetch(fetchSpy);
    await wrappedFetch("https://api.anthropic.com/v1/messages", {
      headers: { "anthropic-version": "2023-06-01" },
    });

    const requestCall = fetchSpy.mock.calls[1];
    const headers = new Headers(requestCall?.[1]?.headers);
    expect(headers.get("Authorization")).toBe("Bearer wif-access-token");
  });
});
