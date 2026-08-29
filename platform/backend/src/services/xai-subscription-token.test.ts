import { vi } from "vitest";
import config from "@/config";
import {
  createXaiSubscriptionFetch,
  refreshBufferFor,
  xaiOauthEndpoints,
  xaiSubscriptionTokenManager,
} from "@/services/xai-subscription-token";
import { afterEach, describe, expect, test } from "@/test";

vi.mock("@/config", async () =>
  (await import("@/test/mocks/config")).configModuleMock({
    llm: {
      xai: {
        baseUrl: "https://api.x.ai/v1",
        subscription: {
          baseUrl: "https://cli-chat-proxy.grok.test/v1",
          issuer: "https://auth.x.ai",
          clientVersion: "1.0.0-test",
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

  test("refuses to widen a two-label issuer host to its entire TLD", async () => {
    // For an issuer host like `x.ai` the "parent domain" would be the bare TLD
    // `ai`; widening to it would admit any *.ai endpoint. Such issuers must
    // match exactly.
    const issuer = "https://two-label.test";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        Response.json({
          device_authorization_endpoint: `${issuer}/oauth2/device/code`,
          token_endpoint: "https://evil.test/oauth2/token",
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

/**
 * Serves OIDC discovery plus the token endpoint from one fetch stub. `mint`
 * decides each redemption's response; the redeemed refresh tokens are recorded
 * so tests can assert which token each redemption spent.
 */
function stubRedemptionFetch(
  mint: (call: { index: number }) => {
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
  },
) {
  const issuer = config.llm.xai.subscription.issuer;
  const redeemedRefreshTokens: Array<string | null> = [];
  const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
    if (String(url).includes("/.well-known/openid-configuration")) {
      return Response.json({
        device_authorization_endpoint: `${issuer}/oauth2/device/code`,
        token_endpoint: `${issuer}/oauth2/token`,
      });
    }
    const body = new URLSearchParams(String(init?.body));
    const index = redeemedRefreshTokens.length;
    redeemedRefreshTokens.push(body.get("refresh_token"));
    return Response.json(mint({ index }));
  });
  vi.stubGlobal("fetch", fetchMock);
  return { redeemedRefreshTokens, fetchMock };
}

// The manager is a module singleton whose token cache survives across tests,
// so every test uses its own providerApiKeyId (and refresh tokens) instead of
// resetting shared state.
describe("xaiSubscriptionTokenManager", () => {
  test("caches the access token per key row", async () => {
    const { redeemedRefreshTokens, fetchMock } = stubRedemptionFetch(
      ({ index }) => ({
        access_token: `at_${index}`,
        expires_in: 3600,
      }),
    );

    const first = await xaiSubscriptionTokenManager.getAccessToken({
      refreshToken: "rt_cache",
      providerApiKeyId: "key-cache",
    });
    const second = await xaiSubscriptionTokenManager.getAccessToken({
      refreshToken: "rt_cache",
      providerApiKeyId: "key-cache",
    });

    expect(first).toBe("at_0");
    expect(second).toBe("at_0");
    expect(redeemedRefreshTokens).toEqual(["rt_cache"]);
    expect(fetchMock.mock.calls.at(-1)?.[1]?.redirect).toBe("manual");
  });

  test("honors a JWT exp shorter than the default TTL when expires_in is absent", async () => {
    // xAI may omit expires_in; when the access token is a JWT its own exp
    // claim is authoritative. An already-expired exp must force a fresh
    // redemption instead of being served from cache for the default hour.
    const expiredJwt = () => {
      const b64url = (value: object) =>
        Buffer.from(JSON.stringify(value)).toString("base64url");
      return `${b64url({ alg: "none" })}.${b64url({
        exp: Math.floor(Date.now() / 1000) - 10,
      })}.sig`;
    };
    const { redeemedRefreshTokens } = stubRedemptionFetch(() => ({
      access_token: expiredJwt(),
      refresh_token: "rt_jwt_exp",
    }));

    await xaiSubscriptionTokenManager.getAccessToken({
      refreshToken: "rt_jwt_exp",
      providerApiKeyId: "key-jwt-exp",
    });
    await xaiSubscriptionTokenManager.getAccessToken({
      refreshToken: "rt_jwt_exp",
      providerApiKeyId: "key-jwt-exp",
    });

    expect(redeemedRefreshTokens).toHaveLength(2);
  });

  test("falls back to the default TTL for an opaque token without expires_in", async () => {
    const { redeemedRefreshTokens } = stubRedemptionFetch(({ index }) => ({
      access_token: `at_${index}`,
    }));

    const first = await xaiSubscriptionTokenManager.getAccessToken({
      refreshToken: "rt_opaque",
      providerApiKeyId: "key-opaque",
    });
    const second = await xaiSubscriptionTokenManager.getAccessToken({
      refreshToken: "rt_opaque",
      providerApiKeyId: "key-opaque",
    });

    expect(first).toBe("at_0");
    expect(second).toBe("at_0");
    expect(redeemedRefreshTokens).toEqual(["rt_opaque"]);
  });

  test("single-flights concurrent redemptions for the same key", async () => {
    const { redeemedRefreshTokens } = stubRedemptionFetch(({ index }) => ({
      access_token: `at_${index}`,
      expires_in: 3600,
    }));

    const [first, second] = await Promise.all([
      xaiSubscriptionTokenManager.getAccessToken({
        refreshToken: "rt_flight",
        providerApiKeyId: "key-flight",
      }),
      xaiSubscriptionTokenManager.getAccessToken({
        refreshToken: "rt_flight",
        providerApiKeyId: "key-flight",
      }),
    ]);

    expect(first).toBe("at_0");
    expect(second).toBe("at_0");
    expect(redeemedRefreshTokens).toEqual(["rt_flight"]);
  });

  test("drops the cached token when the stored credential was replaced", async () => {
    // Reconnecting to a different Grok account swaps the stored refresh token
    // under the same key row; serving the cached access token would answer as
    // the old account.
    const { redeemedRefreshTokens } = stubRedemptionFetch(({ index }) => ({
      access_token: `at_${index}`,
      expires_in: 3600,
    }));

    const first = await xaiSubscriptionTokenManager.getAccessToken({
      refreshToken: "rt_old_account",
      providerApiKeyId: "key-reconnect",
    });
    const second = await xaiSubscriptionTokenManager.getAccessToken({
      refreshToken: "rt_new_account",
      providerApiKeyId: "key-reconnect",
    });

    expect(first).toBe("at_0");
    expect(second).toBe("at_1");
    expect(redeemedRefreshTokens).toEqual(["rt_old_account", "rt_new_account"]);
  });

  test("redeems with the rotated refresh token after the access token is invalidated", async () => {
    const { redeemedRefreshTokens } = stubRedemptionFetch(({ index }) => ({
      access_token: `at_${index}`,
      // Only the first redemption rotates; the follow-up must spend the
      // rotated token rather than the stored (superseded) one.
      ...(index === 0 ? { refresh_token: "rt_rotated" } : {}),
      expires_in: 3600,
    }));

    const first = await xaiSubscriptionTokenManager.getAccessToken({
      refreshToken: "rt_stored",
      providerApiKeyId: "key-rotation",
    });
    xaiSubscriptionTokenManager.invalidate("key-rotation", first);
    const second = await xaiSubscriptionTokenManager.getAccessToken({
      refreshToken: "rt_stored",
      providerApiKeyId: "key-rotation",
    });

    expect(first).toBe("at_0");
    expect(second).toBe("at_1");
    expect(redeemedRefreshTokens).toEqual(["rt_stored", "rt_rotated"]);
  });

  test("keeps the rotated refresh token through the retention window after invalidation", async () => {
    const { redeemedRefreshTokens } = stubRedemptionFetch(({ index }) => ({
      access_token: `at_${index}`,
      ...(index === 0 ? { refresh_token: "rt_rotated_late" } : {}),
      expires_in: 3600,
    }));

    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const first = await xaiSubscriptionTokenManager.getAccessToken({
        refreshToken: "rt_stored_late",
        providerApiKeyId: "key-late-retry",
      });
      xaiSubscriptionTokenManager.invalidate("key-late-retry", first);
      // Well past the cache's default TTL (1h) but inside the 24h rotated-token
      // retention: the rotated token must still be the one spent, not the
      // stored (superseded) one.
      vi.setSystemTime(Date.now() + 2 * 60 * 60 * 1000);
      const second = await xaiSubscriptionTokenManager.getAccessToken({
        refreshToken: "rt_stored_late",
        providerApiKeyId: "key-late-retry",
      });

      expect(second).toBe("at_1");
      expect(redeemedRefreshTokens).toEqual([
        "rt_stored_late",
        "rt_rotated_late",
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  test("keeps a token another request already refreshed when invalidating a stale one", async () => {
    stubRedemptionFetch(({ index }) => ({
      access_token: `at_${index}`,
      expires_in: 3600,
    }));

    const current = await xaiSubscriptionTokenManager.getAccessToken({
      refreshToken: "rt_stale_check",
      providerApiKeyId: "key-stale-check",
    });
    // A concurrent 401 handler holding an older token must not evict the one
    // just minted.
    xaiSubscriptionTokenManager.invalidate("key-stale-check", "at_older");
    const after = await xaiSubscriptionTokenManager.getAccessToken({
      refreshToken: "rt_stale_check",
      providerApiKeyId: "key-stale-check",
    });

    expect(after).toBe(current);
  });
});

describe("createXaiSubscriptionFetch", () => {
  test("retries exactly once with a fresh bearer after a 401", async () => {
    stubRedemptionFetch(({ index }) => ({
      access_token: `at_${index}`,
      expires_in: 3600,
    }));
    const innerFetch = vi
      .fn()
      .mockResolvedValueOnce(new Response("nope", { status: 401 }))
      .mockResolvedValue(new Response("ok"));

    const wrapped = createXaiSubscriptionFetch({
      credential: { refreshToken: "rt_retry", userId: "x-user-123" },
      providerApiKeyId: "key-retry",
      innerFetch,
    });
    const response = await wrapped(
      "https://cli-chat-proxy.grok.test/v1/chat/completions",
      {
        method: "POST",
        headers: { authorization: "Bearer xai-subscription" },
        body: "{}",
      },
    );

    expect(response.status).toBe(200);
    expect(innerFetch).toHaveBeenCalledTimes(2);
    const bearers = innerFetch.mock.calls.map(([, init]) =>
      (init.headers as Headers).get("authorization"),
    );
    expect(bearers).toEqual(["Bearer at_0", "Bearer at_1"]);
  });
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
      credential: {
        refreshToken: "stored-refresh-token",
        userId: "x-user-123",
        email: "x@example.com",
      },
      innerFetch,
    });
    await wrapped("https://cli-chat-proxy.grok.test/v1/chat/completions", {
      method: "POST",
      headers: {
        authorization: "Bearer xai-subscription",
        "x-userid": "attacker-controlled",
      },
      body: "{}",
    });

    const [, init] = innerFetch.mock.calls[0];
    expect((init.headers as Headers).get("authorization")).toBe(
      "Bearer redeemed-access-token",
    );
    expect((init.headers as Headers).get("x-xai-token-auth")).toBe(
      "xai-grok-cli",
    );
    expect((init.headers as Headers).get("x-userid")).toBe("x-user-123");
    expect((init.headers as Headers).get("x-email")).toBe("x@example.com");
    expect((init.headers as Headers).get("x-grok-client-identifier")).toBe(
      "archestra",
    );
    expect((init.headers as Headers).get("x-grok-client-mode")).toBe(
      "headless",
    );
    expect((init.headers as Headers).get("x-grok-client-version")).toBe(
      "1.0.0-test",
    );
    expect((init.headers as Headers).get("user-agent")).toContain(
      "grok-build/1.0.0-test",
    );
    expect((init.headers as Headers).get("x-authenticateresponse")).toBe(
      "authenticate-response",
    );
    expect((init.headers as Headers).get("x-grok-model-override")).toBeNull();
    expect(init.redirect).toBe("manual");
  });

  test("sets the session proxy model-routing header from the request body", async () => {
    stubRedemptionFetch(() => ({
      access_token: "at_model",
      expires_in: 3600,
    }));
    const innerFetch = vi.fn().mockResolvedValue(new Response("ok"));
    const wrapped = createXaiSubscriptionFetch({
      credential: { refreshToken: "rt_model", userId: "x-user-123" },
      innerFetch,
    });

    await wrapped("https://cli-chat-proxy.grok.test/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({ model: "grok-routing-slug", messages: [] }),
    });

    const [, init] = innerFetch.mock.calls[0];
    expect((init.headers as Headers).get("x-grok-model-override")).toBe(
      "grok-routing-slug",
    );
    expect(init.redirect).toBe("manual");
  });

  test("refuses to send the bearer to a base URL outside the configured origin", async () => {
    // Per-key base URLs are user-supplied, so an arbitrary override must never
    // receive somebody's subscription bearer.
    const redeemMock = vi.fn();
    vi.stubGlobal("fetch", redeemMock);
    const innerFetch = vi.fn();

    const wrapped = createXaiSubscriptionFetch({
      credential: {
        refreshToken: "stored-refresh-token",
        userId: "x-user-123",
      },
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

// =============================================================================
// Rotation lifecycle (issue #7206) — mirrors the Codex manager's suite for the
// shared fixes: ID-less validation stash, in-flight lineage isolation, and
// compare-and-swap persistence.
// =============================================================================

describe("ID-less validation rotation stash", () => {
  test("follows an observed rotation instead of redeeming the dead predecessor", async () => {
    const rtA = `rt-a-${crypto.randomUUID()}`;
    const rtB = `rt-b-${crypto.randomUUID()}`;
    const { redeemedRefreshTokens } = stubRedemptionFetch(({ index }) => ({
      access_token: `at_${index}`,
      expires_in: 3600,
      ...(index === 0 ? { refresh_token: rtB } : {}),
    }));

    await xaiSubscriptionTokenManager.getAccessToken({ refreshToken: rtA });
    expect(xaiSubscriptionTokenManager.latestKnownRefreshToken(rtA)).toBe(rtB);

    // Validating the same credential again must redeem the live successor —
    // redeeming rtA again would be invalid_grant (single-use tokens).
    await xaiSubscriptionTokenManager.getAccessToken({ refreshToken: rtA });
    expect(redeemedRefreshTokens).toEqual([rtA, rtB]);
  });
});

describe("in-flight redemption lineage isolation", () => {
  test("does not serve an in-flight redemption to a caller holding a different credential", async () => {
    const rowId = crypto.randomUUID();
    const rtOld = `rt-old-${crypto.randomUUID()}`;
    const rtNew = `rt-new-${crypto.randomUUID()}`;
    const issuer = config.llm.xai.subscription.issuer;
    const resolvers: Array<(response: Response) => void> = [];
    const presentedTokens: Array<string | null> = [];
    const fetchMock = vi.fn((url: string | URL, init?: RequestInit) => {
      if (String(url).includes("/.well-known/openid-configuration")) {
        return Promise.resolve(
          Response.json({
            device_authorization_endpoint: `${issuer}/oauth2/device/code`,
            token_endpoint: `${issuer}/oauth2/token`,
          }),
        );
      }
      return new Promise<Response>((resolve) => {
        presentedTokens.push(
          new URLSearchParams(String(init?.body)).get("refresh_token"),
        );
        resolvers.push(resolve);
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    // Caller 1: the row's old credential (e.g. read before a reconnect).
    const first = xaiSubscriptionTokenManager.getAccessToken({
      refreshToken: rtOld,
      providerApiKeyId: rowId,
    });
    // Caller 2 arrives mid-flight holding the NEW credential after a
    // reconnect. Joining caller 1's flight would hand it the old account's
    // bearer.
    const second = xaiSubscriptionTokenManager.getAccessToken({
      refreshToken: rtNew,
      providerApiKeyId: rowId,
    });

    await vi.waitFor(() => expect(resolvers).toHaveLength(2));
    resolvers[0](Response.json({ access_token: "at_old", expires_in: 3600 }));
    resolvers[1](Response.json({ access_token: "at_new", expires_in: 3600 }));

    expect(await first).toBe("at_old");
    expect(await second).toBe("at_new");
    expect(presentedTokens).toEqual([rtOld, rtNew]);
  });
});

describe("rotation persistence compare-and-swap", () => {
  test("skips the write when the stored credential is a different token family", async ({
    makeOrganization,
    makeUser,
  }) => {
    const { LlmProviderApiKeyModel } = await import("@/models");
    const { getSecretValueForLlmProviderApiKey, secretManager } = await import(
      "@/secrets-manager"
    );
    const { decodeXaiSubscriptionCredential, encodeXaiSubscriptionCredential } =
      await import("./xai-subscription-credentials");

    const organization = await makeOrganization();
    const user = await makeUser();
    // The row already holds a FRESH credential (a completed reconnect)…
    const rtFresh = `rt-fresh-${crypto.randomUUID()}`;
    const freshStored = encodeXaiSubscriptionCredential({
      refreshToken: rtFresh,
      userId: "x-user-1",
    });
    const secret = await secretManager().createSecret(
      { apiKey: freshStored },
      `xai-test-${crypto.randomUUID()}`,
    );
    const key = await LlmProviderApiKeyModel.create({
      organizationId: organization.id,
      name: "SuperGrok",
      provider: "xai",
      secretId: secret.id,
      scope: "personal",
      userId: user.id,
    });
    // …while a caller still holding the PREVIOUS credential redeems it and
    // observes a rotation. Persisting that rotation would clobber the fresh
    // sign-in with a dead family.
    const rtOld = `rt-old-${crypto.randomUUID()}`;
    const rtOldRotated = `rt-old2-${crypto.randomUUID()}`;
    stubRedemptionFetch(({ index }) => ({
      access_token: `at_${index}`,
      expires_in: 3600,
      ...(index === 0 ? { refresh_token: rtOldRotated } : {}),
    }));

    await xaiSubscriptionTokenManager.getAccessToken({
      refreshToken: rtOld,
      providerApiKeyId: key.id,
    });
    await xaiSubscriptionTokenManager.waitForPersistFlush(key.id);

    const value = await getSecretValueForLlmProviderApiKey(secret.id);
    expect(decodeXaiSubscriptionCredential(value)).toMatchObject({
      refreshToken: rtFresh,
    });
  });
});
