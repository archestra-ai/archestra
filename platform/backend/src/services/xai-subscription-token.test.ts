import { vi } from "vitest";
import config from "@/config";
import {
  createXaiSubscriptionFetch,
  refreshBufferFor,
  xaiOauthEndpoints,
} from "@/services/xai-subscription-token";
import { afterEach, describe, expect, test } from "@/test";

vi.mock("@/config", async () =>
  (await import("@/test/mocks/config")).configModuleMock({
    llm: {
      xai: {
        baseUrl: "https://api.x.ai/v1",
        subscription: {
          issuer: "https://auth.x.ai",
          clientId: "test-xai-client-id",
          scopes: "openid offline_access api:access",
        },
      },
    },
  }),
);

/**
 * Discovery is memoized per issuer for the process lifetime, so each test that
 * exercises discovery uses its own issuer rather than resetting shared state.
 */
let issuerCounter = 0;
function uniqueIssuer(): string {
  issuerCounter += 1;
  return `https://auth.t${issuerCounter}.test`;
}

async function withIssuer<T>(
  issuer: string,
  run: () => Promise<T>,
): Promise<T> {
  const original = config.llm.xai.subscription.issuer;
  config.llm.xai.subscription.issuer = issuer;
  try {
    return await run();
  } finally {
    config.llm.xai.subscription.issuer = original;
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("xaiOauthEndpoints", () => {
  test("reads the device and token endpoints from OIDC discovery", async () => {
    const issuer = uniqueIssuer();
    const host = new URL(issuer).hostname;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        Response.json({
          device_authorization_endpoint: `${issuer}/oauth2/device/code`,
          token_endpoint: `${issuer}/oauth2/token`,
        }),
      ),
    );

    const endpoints = await withIssuer(issuer, xaiOauthEndpoints);

    expect(endpoints.deviceAuthorizationEndpoint).toBe(
      `https://${host}/oauth2/device/code`,
    );
    expect(endpoints.tokenEndpoint).toBe(`https://${host}/oauth2/token`);
  });

  test("memoizes discovery so the hot path does not refetch it", async () => {
    const issuer = uniqueIssuer();
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json({
        device_authorization_endpoint: `${issuer}/oauth2/device/code`,
        token_endpoint: `${issuer}/oauth2/token`,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await withIssuer(issuer, xaiOauthEndpoints);
    await withIssuer(issuer, xaiOauthEndpoints);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("accepts an endpoint on a sibling host under the issuer's domain", async () => {
    const issuer = uniqueIssuer();
    const parent = new URL(issuer).hostname.split(".").slice(1).join(".");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        Response.json({
          device_authorization_endpoint: `${issuer}/oauth2/device/code`,
          token_endpoint: `https://api.${parent}/oauth2/token`,
        }),
      ),
    );

    const endpoints = await withIssuer(issuer, xaiOauthEndpoints);

    expect(endpoints.tokenEndpoint).toBe(`https://api.${parent}/oauth2/token`);
  });

  test("refuses an endpoint outside the issuer's domain", async () => {
    // The discovery document arrives over the network; an unvalidated endpoint
    // would be an open redirect for the client id and the refresh token.
    const issuer = uniqueIssuer();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        Response.json({
          device_authorization_endpoint: `${issuer}/oauth2/device/code`,
          token_endpoint: "https://evil.example.com/oauth2/token",
        }),
      ),
    );

    await expect(withIssuer(issuer, xaiOauthEndpoints)).rejects.toThrow(
      /out-of-domain/,
    );
  });

  test("refuses an endpoint that downgrades the issuer's scheme", async () => {
    const issuer = uniqueIssuer();
    const host = new URL(issuer).hostname;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        Response.json({
          device_authorization_endpoint: `http://${host}/oauth2/device/code`,
          token_endpoint: `${issuer}/oauth2/token`,
        }),
      ),
    );

    await expect(withIssuer(issuer, xaiOauthEndpoints)).rejects.toThrow(
      /out-of-domain/,
    );
  });
});

describe("refreshBufferFor", () => {
  test("caps the headroom for long-lived tokens", () => {
    expect(refreshBufferFor(60 * 60 * 1000)).toBe(5 * 60 * 1000);
  });

  test("keeps the headroom a fraction of a short lifetime", () => {
    // A flat buffer at or above the lifetime would re-redeem on every request,
    // which is the failure this bound exists to prevent.
    const lifetimeMs = 120 * 1000;
    const buffer = refreshBufferFor(lifetimeMs);
    expect(buffer).toBe(30 * 1000);
    expect(buffer).toBeLessThan(lifetimeMs);
  });

  test("treats a non-positive lifetime as no headroom", () => {
    expect(refreshBufferFor(0)).toBe(0);
    expect(refreshBufferFor(-1)).toBe(0);
  });
});

describe("createXaiSubscriptionFetch", () => {
  test("replaces the placeholder key with the redeemed bearer", async () => {
    const issuer = config.llm.xai.subscription.issuer;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL) =>
        String(url).includes("/.well-known/openid-configuration")
          ? Response.json({
              device_authorization_endpoint: `${issuer}/oauth2/device/code`,
              token_endpoint: `${issuer}/oauth2/token`,
            })
          : Response.json({
              access_token: "redeemed-access-token",
              expires_in: 3600,
            }),
      ),
    );
    const innerFetch = vi.fn().mockResolvedValue(new Response("ok"));

    const wrapped = createXaiSubscriptionFetch({
      credential: { refreshToken: "stored-refresh-token" },
      innerFetch,
    });
    await wrapped("https://api.x.ai/v1/chat/completions", {
      method: "POST",
      headers: { authorization: "Bearer xai-subscription" },
      body: "{}",
    });

    const [, init] = innerFetch.mock.calls[0];
    expect((init.headers as Headers).get("authorization")).toBe(
      "Bearer redeemed-access-token",
    );
  });

  test("refuses to send the bearer to a base URL outside the configured origin", async () => {
    // Per-key base URLs are user-supplied, so an arbitrary override must never
    // receive somebody's subscription bearer.
    const redeemMock = vi.fn();
    vi.stubGlobal("fetch", redeemMock);
    const innerFetch = vi.fn();

    const wrapped = createXaiSubscriptionFetch({
      credential: { refreshToken: "stored-refresh-token" },
      innerFetch,
    });
    const response = await wrapped("https://evil.example.com/v1/models");

    expect(response.status).toBe(400);
    expect(innerFetch).not.toHaveBeenCalled();
    // The refusal happens before any redemption, so the refresh token is never
    // spent on a request that would have been dropped anyway.
    expect(redeemMock).not.toHaveBeenCalled();
  });

  test("passes through untouched when the key is not a subscription credential", async () => {
    const innerFetch = vi.fn().mockResolvedValue(new Response("ok"));

    const wrapped = createXaiSubscriptionFetch({
      credential: undefined,
      innerFetch,
    });
    await wrapped("https://api.x.ai/v1/models");

    expect(innerFetch).toHaveBeenCalledTimes(1);
  });
});
