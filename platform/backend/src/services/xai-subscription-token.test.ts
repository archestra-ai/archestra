import { ArchestraInternalErrorCode } from "@archestra/shared";
import { assert, vi } from "vitest";
import config from "@/config";
import LlmProviderApiKeyModel from "@/models/llm-provider-api-key";
import SecretModel from "@/models/secret";
import { secretManager } from "@/secrets-manager";
import {
  createXaiSubscriptionFetch,
  refreshBufferFor,
  XaiSubscriptionTokenManager,
  xaiOauthEndpoints,
  xaiSubscriptionTokenManager,
} from "@/services/xai-subscription-token";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import { withLatestRotatedRefreshToken } from "./subscription-credential-rotation";
import {
  decodeXaiSubscriptionCredential,
  encodeXaiSubscriptionCredential,
  type XaiSubscriptionCredential,
} from "./xai-subscription-credentials";

/**
 * Lets a test make the lock helper's transaction fail after its callback
 * returned, the way a lost connection at commit does, so the retry path of
 * `withDbTransaction` runs the callback again.
 */
const lockFaults = vi.hoisted(() => ({ failAfterRun: 0 }));
vi.mock("@/models/subscription-credential-lock", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/models/subscription-credential-lock")
    >();
  const withSubscriptionCredentialLock = (
    params: Parameters<typeof actual.withSubscriptionCredentialLock>[0],
  ) =>
    actual.withSubscriptionCredentialLock({
      ...params,
      run: async (transaction) => {
        const outcome = await params.run(transaction);
        if (lockFaults.failAfterRun > 0) {
          lockFaults.failAfterRun -= 1;
          throw Object.assign(new Error("Connection terminated unexpectedly"), {
            code: "ECONNRESET",
          });
        }
        return outcome;
      },
    });
  return { ...actual, withSubscriptionCredentialLock };
});

beforeEach(() => {
  config.llm.xai.baseUrl = "https://api.x.ai/v1";
  config.llm.xai.subscription.baseUrl = "https://cli-chat-proxy.grok.test/v1";
  config.llm.xai.subscription.issuer = "https://auth.x.ai";
  config.llm.xai.subscription.clientVersion = "1.0.0-test";
  config.llm.xai.subscription.clientId = "test-xai-client-id";
  config.llm.xai.subscription.scopes = "openid offline_access api:access";
});

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

const tokenTest = test.extend<{
  subscriptionKey: {
    id: string;
    secretId: string;
    credential: XaiSubscriptionCredential;
  };
}>({
  subscriptionKey: async (
    { makeOrganization, makeUser, makeLlmProviderApiKey },
    use,
  ) => {
    const organization = await makeOrganization();
    const user = await makeUser();
    const credential = { refreshToken: "rt_0", userId: "test-account" };
    const secret = await secretManager().createSecret(
      { apiKey: encodeXaiSubscriptionCredential(credential) },
      "subscription-test",
    );
    const key = await makeLlmProviderApiKey(organization.id, secret.id, {
      provider: "xai",
      userId: user.id,
    });
    await use({ id: key.id, secretId: secret.id, credential });
  },
});

function stubSingleUseIssuer() {
  const issuer = config.llm.xai.subscription.issuer;
  const state = {
    calls: [] as string[],
    familyDead: false,
    expiresIn: 3600,
    accessToken: undefined as string | undefined,
    omitExpiry: false,
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL, init?: RequestInit) => {
      if (String(url).includes("/.well-known/openid-configuration")) {
        return Response.json({
          device_authorization_endpoint: `${issuer}/oauth2/device/code`,
          token_endpoint: `${issuer}/oauth2/token`,
        });
      }
      const presented =
        new URLSearchParams(String(init?.body)).get("refresh_token") ?? "";
      const expected = `rt_${state.calls.length}`;
      state.calls.push(presented);
      if (state.familyDead || presented !== expected) {
        state.familyDead = true;
        return Response.json(
          {
            error: "invalid_grant",
            error_description: "Refresh token has been revoked",
          },
          { status: 400 },
        );
      }
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      expect(init?.redirect).toBe("manual");
      return Response.json({
        access_token: state.accessToken ?? `at_${state.calls.length}`,
        refresh_token: `rt_${state.calls.length}`,
        ...(state.omitExpiry ? {} : { expires_in: state.expiresIn }),
      });
    }),
  );
  return state;
}

async function readCredential(secretId: string) {
  const secret = await secretManager().getSecret(secretId, { skipCache: true });
  return decodeXaiSubscriptionCredential(secret?.secret.apiKey as string);
}

async function replaceCredential(params: {
  secretId: string;
  credential: XaiSubscriptionCredential;
}) {
  await SecretModel.update(params.secretId, {
    secret: { apiKey: encodeXaiSubscriptionCredential(params.credential) },
  });
}

describe("xaiSubscriptionTokenManager", () => {
  for (const lifetimeSeconds of [120, 3600]) {
    tokenTest(
      `refreshes within the cached token's own buffer for a ${lifetimeSeconds}s lifetime`,
      async ({ subscriptionKey }) => {
        const issuer = stubSingleUseIssuer();
        issuer.expiresIn = lifetimeSeconds;
        const manager = new XaiSubscriptionTokenManager();
        const params = {
          credential: subscriptionKey.credential,
          providerApiKeyId: subscriptionKey.id,
        };
        await manager.getAccessToken(params);
        vi.useFakeTimers({ toFake: ["Date"] });
        try {
          vi.setSystemTime(
            Date.now() +
              lifetimeSeconds * 1000 -
              refreshBufferFor(lifetimeSeconds * 1000) +
              1,
          );
          expect(await manager.getAccessToken(params)).toBe("at_2");
          expect(issuer.calls).toEqual(["rt_0", "rt_1"]);
        } finally {
          vi.useRealTimers();
        }
      },
    );
  }

  tokenTest(
    "shares the persisted access token across replicas with stale caller credentials",
    async ({ subscriptionKey }) => {
      const issuer = stubSingleUseIssuer();
      const replicaA = new XaiSubscriptionTokenManager();
      const replicaB = new XaiSubscriptionTokenManager();
      const params = {
        credential: subscriptionKey.credential,
        providerApiKeyId: subscriptionKey.id,
      };
      expect(await replicaA.getAccessToken(params)).toBe("at_1");
      expect(await replicaB.getAccessToken(params)).toBe("at_1");
      expect(issuer.calls).toEqual(["rt_0"]);
      expect(issuer.familyDead).toBe(false);
      expect(await readCredential(subscriptionKey.secretId)).toMatchObject({
        refreshToken: "rt_1",
        accessToken: "at_1",
        accessTokenExpiresAtMs: expect.any(Number),
      });
    },
  );

  tokenTest(
    "concurrent expired replicas redeem exactly once and persist before returning",
    async ({ subscriptionKey }) => {
      const issuer = stubSingleUseIssuer();
      const replicaA = new XaiSubscriptionTokenManager();
      const replicaB = new XaiSubscriptionTokenManager();
      const params = {
        credential: subscriptionKey.credential,
        providerApiKeyId: subscriptionKey.id,
      };
      await replicaA.getAccessToken(params);
      await replicaB.getAccessToken(params);
      vi.useFakeTimers({ toFake: ["Date"] });
      try {
        vi.setSystemTime(Date.now() + 2 * 60 * 60 * 1000);
        // PGlite has one connection: transactions queue rather than interleave; the real advisory lock still executes.
        const tokens = await Promise.all([
          replicaA.getAccessToken(params),
          replicaB.getAccessToken(params),
        ]);
        expect(tokens).toEqual(["at_2", "at_2"]);
        expect(issuer.calls).toEqual(["rt_0", "rt_1"]);
        expect(issuer.familyDead).toBe(false);
        expect(await readCredential(subscriptionKey.secretId)).toMatchObject({
          refreshToken: "rt_2",
          accessToken: "at_2",
        });
      } finally {
        vi.useRealTimers();
      }
    },
  );

  tokenTest(
    "keeps the process cache when a caller has an unknown refresh token for the same user",
    async ({ subscriptionKey }) => {
      const issuer = stubSingleUseIssuer();
      const manager = new XaiSubscriptionTokenManager();
      const params = {
        credential: subscriptionKey.credential,
        providerApiKeyId: subscriptionKey.id,
      };
      await manager.getAccessToken(params);
      const token = await manager.getAccessToken({
        ...params,
        credential: { ...params.credential, refreshToken: "rt_unknown" },
      });
      expect(token).toBe("at_1");
      expect(issuer.calls).toEqual(["rt_0"]);
    },
  );

  tokenTest(
    "adopts a newer stored access token after a cached token gets a 401",
    async ({ subscriptionKey }) => {
      const issuer = stubSingleUseIssuer();
      const manager = new XaiSubscriptionTokenManager();
      const params = {
        credential: subscriptionKey.credential,
        providerApiKeyId: subscriptionKey.id,
      };
      await manager.getAccessToken(params);
      const stored = await readCredential(subscriptionKey.secretId);
      assert(stored);
      await replaceCredential({
        secretId: subscriptionKey.secretId,
        credential: { ...stored, accessToken: "at_from_replica_b" },
      });
      manager.invalidate(subscriptionKey.id, "at_1");
      expect(
        await manager.getAccessToken({ ...params, staleAccessToken: "at_1" }),
      ).toBe("at_from_replica_b");
      expect(issuer.calls).toEqual(["rt_0"]);
    },
  );

  tokenTest(
    "redeems the stored successor once after invalidation when no newer token exists",
    async ({ subscriptionKey }) => {
      const issuer = stubSingleUseIssuer();
      const manager = new XaiSubscriptionTokenManager();
      const params = {
        credential: subscriptionKey.credential,
        providerApiKeyId: subscriptionKey.id,
      };
      await manager.getAccessToken(params);
      manager.invalidate(subscriptionKey.id, "at_1");
      expect(
        await manager.getAccessToken({ ...params, staleAccessToken: "at_1" }),
      ).toBe("at_2");
      expect(issuer.calls).toEqual(["rt_0", "rt_1"]);
    },
  );

  tokenTest(
    "does not evict a newer cached token on a late 401 for an older token",
    async ({ subscriptionKey }) => {
      const issuer = stubSingleUseIssuer();
      const manager = new XaiSubscriptionTokenManager();
      const params = {
        credential: subscriptionKey.credential,
        providerApiKeyId: subscriptionKey.id,
      };
      const current = await manager.getAccessToken(params);
      manager.invalidate(subscriptionKey.id, "at_older");
      expect(await manager.getAccessToken(params)).toBe(current);
      expect(issuer.calls).toHaveLength(1);
    },
  );

  tokenTest(
    "rejects a stored account different from the caller without redeeming",
    async ({ subscriptionKey }) => {
      const issuer = stubSingleUseIssuer();
      const manager = new XaiSubscriptionTokenManager();
      await expect(
        manager.getAccessToken({
          credential: {
            ...subscriptionKey.credential,
            userId: "different-account",
          },
          providerApiKeyId: subscriptionKey.id,
        }),
      ).rejects.toMatchObject({
        statusCode: 401,
        internalCode: ArchestraInternalErrorCode.ProviderAuthRequired,
      });
      expect(issuer.calls).toHaveLength(0);
      expect(
        (await LlmProviderApiKeyModel.findById(subscriptionKey.id))
          ?.requiresReauthentication,
      ).toBe(false);
    },
  );

  tokenTest(
    "does not join another account's in-flight redemption",
    async ({ subscriptionKey }) => {
      const issuer = stubSingleUseIssuer();
      const manager = new XaiSubscriptionTokenManager();
      const results = await Promise.allSettled([
        manager.getAccessToken({
          credential: subscriptionKey.credential,
          providerApiKeyId: subscriptionKey.id,
        }),
        manager.getAccessToken({
          credential: {
            ...subscriptionKey.credential,
            userId: "different-account",
          },
          providerApiKeyId: subscriptionKey.id,
        }),
      ]);
      expect(results[0]).toEqual({ status: "fulfilled", value: "at_1" });
      expect(results[1]).toMatchObject({
        status: "rejected",
        reason: {
          statusCode: 401,
          internalCode: ArchestraInternalErrorCode.ProviderAuthRequired,
        },
      });
      expect(issuer.calls).toHaveLength(1);
    },
  );

  tokenTest(
    "rejects an unreadable or replaced stored credential without redeeming",
    async ({ subscriptionKey }) => {
      const issuer = stubSingleUseIssuer();
      await SecretModel.update(subscriptionKey.secretId, {
        secret: { apiKey: "plain-api-key" },
      });
      await expect(
        new XaiSubscriptionTokenManager().getAccessToken({
          credential: subscriptionKey.credential,
          providerApiKeyId: subscriptionKey.id,
        }),
      ).rejects.toMatchObject({
        statusCode: 401,
        internalCode: ArchestraInternalErrorCode.ProviderAuthRequired,
      });
      expect(issuer.calls).toHaveLength(0);
    },
  );

  tokenTest(
    "flags invalid_grant only for the rejected stored credential",
    async ({ subscriptionKey }) => {
      const issuer = stubSingleUseIssuer();
      issuer.familyDead = true;
      await expect(
        new XaiSubscriptionTokenManager().getAccessToken({
          credential: subscriptionKey.credential,
          providerApiKeyId: subscriptionKey.id,
        }),
      ).rejects.toMatchObject({
        statusCode: 401,
        internalCode: ArchestraInternalErrorCode.ProviderAuthRequired,
      });
      expect(
        (await LlmProviderApiKeyModel.findById(subscriptionKey.id))
          ?.requiresReauthentication,
      ).toBe(true);
      expect(issuer.calls).toEqual(["rt_0"]);
    },
  );

  tokenTest(
    "ignores a rejected predecessor after the stored credential is replaced, bypassing the secret cache",
    async ({ subscriptionKey }) => {
      await secretManager().getSecret(subscriptionKey.secretId);
      await replaceCredential({
        secretId: subscriptionKey.secretId,
        credential: {
          ...subscriptionKey.credential,
          refreshToken: "rt_reconnected",
        },
      });
      await new XaiSubscriptionTokenManager().recordAuthenticationFailure({
        providerApiKeyId: subscriptionKey.id,
        credential: subscriptionKey.credential,
      });
      expect(
        (await LlmProviderApiKeyModel.findById(subscriptionKey.id))
          ?.requiresReauthentication,
      ).toBe(false);
    },
  );

  tokenTest(
    "does not flag a rejected credential for another user even when the token matches",
    async ({ subscriptionKey }) => {
      await new XaiSubscriptionTokenManager().recordAuthenticationFailure({
        providerApiKeyId: subscriptionKey.id,
        credential: {
          ...subscriptionKey.credential,
          userId: "different-account",
        },
      });
      expect(
        (await LlmProviderApiKeyModel.findById(subscriptionKey.id))
          ?.requiresReauthentication,
      ).toBe(false);
    },
  );

  tokenTest(
    "uses the stored family rather than clobbering a reconnect with a stale caller's rotation",
    async ({ subscriptionKey }) => {
      const issuer = stubSingleUseIssuer();
      expect(
        await new XaiSubscriptionTokenManager().getAccessToken({
          credential: {
            ...subscriptionKey.credential,
            refreshToken: "spent-before-reconnect",
          },
          providerApiKeyId: subscriptionKey.id,
        }),
      ).toBe("at_1");
      expect(issuer.calls).toEqual(["rt_0"]);
      expect(
        (await readCredential(subscriptionKey.secretId))?.refreshToken,
      ).toBe("rt_1");
    },
  );

  tokenTest(
    "honors a JWT exp shorter than expires_in",
    async ({ subscriptionKey }) => {
      const issuer = stubSingleUseIssuer();
      issuer.accessToken = `header.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) - 10 })).toString("base64url")}.sig`;
      const manager = new XaiSubscriptionTokenManager();
      const params = {
        credential: subscriptionKey.credential,
        providerApiKeyId: subscriptionKey.id,
      };
      await manager.getAccessToken(params);
      await manager.getAccessToken(params);
      expect(issuer.calls).toEqual(["rt_0", "rt_1"]);
    },
  );

  tokenTest(
    "falls back to the default TTL for an opaque token without expires_in",
    async ({ subscriptionKey }) => {
      const issuer = stubSingleUseIssuer();
      issuer.omitExpiry = true;
      const manager = new XaiSubscriptionTokenManager();
      const params = {
        credential: subscriptionKey.credential,
        providerApiKeyId: subscriptionKey.id,
      };
      expect(await manager.getAccessToken(params)).toBe("at_1");
      expect(await manager.getAccessToken(params)).toBe("at_1");
      expect(issuer.calls).toEqual(["rt_0"]);
    },
  );

  tokenTest(
    "persists the validation access token and rotation for the first keyed request",
    async ({ subscriptionKey }) => {
      const issuer = stubSingleUseIssuer();
      await xaiSubscriptionTokenManager.getAccessToken({
        credential: subscriptionKey.credential,
      });
      const value = withLatestRotatedRefreshToken(
        encodeXaiSubscriptionCredential(subscriptionKey.credential),
      );
      await SecretModel.update(subscriptionKey.secretId, {
        secret: { apiKey: value },
      });
      const decoded = decodeXaiSubscriptionCredential(value);
      assert(decoded);
      expect(
        await new XaiSubscriptionTokenManager().getAccessToken({
          credential: decoded,
          providerApiKeyId: subscriptionKey.id,
        }),
      ).toBe("at_1");
      expect(issuer.calls).toEqual(["rt_0"]);
      expect(await readCredential(subscriptionKey.secretId)).toMatchObject({
        accessToken: "at_1",
        refreshToken: "rt_1",
        accessTokenExpiresAtMs: expect.any(Number),
      });
    },
  );
});

describe("shared refresh guards", () => {
  tokenTest(
    "adopts a stored access token only while it keeps the minimum remaining lifetime",
    async ({ subscriptionKey }) => {
      const issuer = stubSingleUseIssuer();
      const params = {
        credential: subscriptionKey.credential,
        providerApiKeyId: subscriptionKey.id,
      };
      await replaceCredential({
        secretId: subscriptionKey.secretId,
        credential: {
          ...subscriptionKey.credential,
          accessToken: "at_nearly_expired",
          accessTokenExpiresAtMs: Date.now() + 10_000,
        },
      });
      // Ten seconds left is not worth serving: the refresh token is redeemed.
      expect(
        await new XaiSubscriptionTokenManager().getAccessToken(params),
      ).toBe("at_1");
      expect(issuer.calls).toEqual(["rt_0"]);

      await replaceCredential({
        secretId: subscriptionKey.secretId,
        credential: {
          ...subscriptionKey.credential,
          refreshToken: "rt_1",
          accessToken: "at_from_replica_b",
          accessTokenExpiresAtMs: Date.now() + 10 * 60_000,
        },
      });
      // Ten minutes left is adopted without touching the issuer.
      expect(
        await new XaiSubscriptionTokenManager().getAccessToken(params),
      ).toBe("at_from_replica_b");
      expect(issuer.calls).toEqual(["rt_0"]);
    },
  );

  tokenTest(
    "shares one refresh among concurrent misses in the same process",
    async ({ subscriptionKey }) => {
      const issuer = stubSingleUseIssuer();
      const manager = new XaiSubscriptionTokenManager();
      const reads = vi.spyOn(secretManager(), "getSecret");
      try {
        const tokens = await Promise.all(
          Array.from({ length: 5 }, () =>
            manager.getAccessToken({
              credential: subscriptionKey.credential,
              providerApiKeyId: subscriptionKey.id,
            }),
          ),
        );
        expect(tokens).toEqual(Array(5).fill("at_1"));
        expect(issuer.calls).toEqual(["rt_0"]);
        // One lock-free read, one locked read, one read of the committed row:
        // the other four callers waited for the same refresh.
        expect(reads).toHaveBeenCalledTimes(3);
      } finally {
        reads.mockRestore();
      }
    },
  );

  /** Makes the next `count` secret writes fail with a network-shaped error. */
  function failWrites(count: number) {
    let remaining = count;
    const real = secretManager().updateSecret.bind(secretManager());
    return vi
      .spyOn(secretManager(), "updateSecret")
      .mockImplementation(async (...args) => {
        if (remaining > 0) {
          remaining -= 1;
          throw Object.assign(new Error("Connection terminated unexpectedly"), {
            code: "ECONNRESET",
          });
        }
        return real(...args);
      });
  }

  tokenTest(
    "retries a failed write-back under the lock, so another replica adopts the rotation",
    async ({ subscriptionKey }) => {
      const issuer = stubSingleUseIssuer();
      const writes = failWrites(1);
      const params = {
        credential: subscriptionKey.credential,
        providerApiKeyId: subscriptionKey.id,
      };
      try {
        expect(
          await new XaiSubscriptionTokenManager().getAccessToken(params),
        ).toBe("at_1");
        expect(writes).toHaveBeenCalledTimes(2);
        // Replica B finds the rotation stored and never touches the issuer.
        expect(
          await new XaiSubscriptionTokenManager().getAccessToken(params),
        ).toBe("at_1");
        expect(issuer.calls).toEqual(["rt_0"]);
      } finally {
        writes.mockRestore();
      }
    },
  );

  tokenTest(
    "persists a rotation whose write-back kept failing on the next refresh, without redeeming again",
    async ({ subscriptionKey }) => {
      const issuer = stubSingleUseIssuer();
      // Every attempt under the lock fails: the lock is released, the caller
      // sees the failure, and the rotation stays pending in this process.
      const writes = failWrites(3);
      const manager = new XaiSubscriptionTokenManager();
      const params = {
        credential: subscriptionKey.credential,
        providerApiKeyId: subscriptionKey.id,
      };
      try {
        await expect(manager.getAccessToken(params)).rejects.toMatchObject({
          statusCode: 502,
        });
        expect(issuer.calls).toEqual(["rt_0"]);
        expect(writes).toHaveBeenCalledTimes(3);
        expect(await readCredential(subscriptionKey.secretId)).toEqual(
          subscriptionKey.credential,
        );
        // The next refresh writes the successor it already holds.
        expect(await manager.getAccessToken(params)).toBe("at_1");
        expect(issuer.calls).toEqual(["rt_0"]);
        expect(writes).toHaveBeenCalledTimes(4);
        expect(await readCredential(subscriptionKey.secretId)).toMatchObject({
          refreshToken: "rt_1",
          accessToken: "at_1",
        });
      } finally {
        writes.mockRestore();
      }
    },
  );

  tokenTest(
    "another replica refreshing first after a lost write-back presents the spent token and flags the key",
    async ({ subscriptionKey }) => {
      const issuer = stubSingleUseIssuer();
      const writes = failWrites(3);
      const params = {
        credential: subscriptionKey.credential,
        providerApiKeyId: subscriptionKey.id,
      };
      try {
        await expect(
          new XaiSubscriptionTokenManager().getAccessToken(params),
        ).rejects.toMatchObject({ statusCode: 502 });
      } finally {
        writes.mockRestore();
      }
      // The accepted residual: the successor lives only in replica A, so
      // replica B redeems the stored (spent) token and the family is revoked.
      await expect(
        new XaiSubscriptionTokenManager().getAccessToken(params),
      ).rejects.toMatchObject({
        statusCode: 401,
        internalCode: ArchestraInternalErrorCode.ProviderAuthRequired,
      });
      expect(issuer.calls).toEqual(["rt_0", "rt_0"]);
      expect(
        (await LlmProviderApiKeyModel.findById(subscriptionKey.id))
          ?.requiresReauthentication,
      ).toBe(true);
    },
  );

  tokenTest(
    "redeems the live successor instead of persisting a pending access token that expired",
    async ({ subscriptionKey }) => {
      const issuer = stubSingleUseIssuer();
      issuer.expiresIn = 60;
      const writes = failWrites(3);
      const manager = new XaiSubscriptionTokenManager();
      const params = {
        credential: subscriptionKey.credential,
        providerApiKeyId: subscriptionKey.id,
      };
      try {
        await expect(manager.getAccessToken(params)).rejects.toMatchObject({
          statusCode: 502,
        });
      } finally {
        writes.mockRestore();
      }
      vi.useFakeTimers({ toFake: ["Date"] });
      try {
        vi.setSystemTime(Date.now() + 61_000);
        // at_1 is past its lifetime; rt_1 (never presented) is redeemed once.
        expect(await manager.getAccessToken(params)).toBe("at_2");
        expect(issuer.calls).toEqual(["rt_0", "rt_1"]);
        expect(await readCredential(subscriptionKey.secretId)).toMatchObject({
          refreshToken: "rt_2",
          accessToken: "at_2",
        });
      } finally {
        vi.useRealTimers();
      }
    },
  );

  tokenTest(
    "drops a pending rotation once a reconnect replaced the stored credential",
    async ({ subscriptionKey }) => {
      const issuer = stubSingleUseIssuer();
      const writes = failWrites(3);
      const manager = new XaiSubscriptionTokenManager();
      const params = {
        credential: subscriptionKey.credential,
        providerApiKeyId: subscriptionKey.id,
      };
      try {
        await expect(manager.getAccessToken(params)).rejects.toMatchObject({
          statusCode: 502,
        });
        // A reconnect stores a new family with its own fresh access token.
        await replaceCredential({
          secretId: subscriptionKey.secretId,
          credential: {
            ...subscriptionKey.credential,
            refreshToken: "rt_reconnected",
            accessToken: "at_reconnected",
            accessTokenExpiresAtMs: Date.now() + 10 * 60_000,
          },
        });
        // Adopted as is: the held rotation of the old family is not written
        // over it, and nothing is redeemed.
        expect(await manager.getAccessToken(params)).toBe("at_reconnected");
        expect(issuer.calls).toEqual(["rt_0"]);
        expect(writes).toHaveBeenCalledTimes(3);
        expect(await readCredential(subscriptionKey.secretId)).toMatchObject({
          refreshToken: "rt_reconnected",
        });
      } finally {
        writes.mockRestore();
      }
    },
  );

  tokenTest(
    "a 401 waiter refreshes only after the shared flight it joined has ended",
    async ({ subscriptionKey }) => {
      const issuer = stubSingleUseIssuer();
      await replaceCredential({
        secretId: subscriptionKey.secretId,
        credential: {
          ...subscriptionKey.credential,
          accessToken: "at_stored",
          accessTokenExpiresAtMs: Date.now() + 10 * 60_000,
        },
      });
      const manager = new XaiSubscriptionTokenManager();
      const params = {
        credential: subscriptionKey.credential,
        providerApiKeyId: subscriptionKey.id,
      };
      // A plain miss adopts the stored token; a caller that just saw that very
      // token rejected joins its flight, then refreshes on its own terms once
      // the flight is gone. One redemption in total.
      const [adopted, refreshed] = await Promise.all([
        manager.getAccessToken(params),
        manager.getAccessToken({ ...params, staleAccessToken: "at_stored" }),
      ]);
      expect(adopted).toBe("at_stored");
      expect(refreshed).toBe("at_1");
      expect(issuer.calls).toEqual(["rt_0"]);
    },
  );

  tokenTest(
    "does not present the refresh token again when the issuer request fails",
    async ({ subscriptionKey }) => {
      const issuer = stubSingleUseIssuer();
      const issuerFetch = globalThis.fetch;
      let dropped = false;
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string | URL, init?: RequestInit) => {
          if (!dropped && String(url).endsWith("/oauth2/token")) {
            dropped = true;
            // What a reset socket looks like from fetch: an error the
            // transaction retry wrapper would otherwise treat as transient.
            throw Object.assign(new TypeError("fetch failed"), {
              cause: Object.assign(new Error("read ECONNRESET"), {
                code: "ECONNRESET",
              }),
            });
          }
          return issuerFetch(url, init);
        }),
      );
      const params = {
        credential: subscriptionKey.credential,
        providerApiKeyId: subscriptionKey.id,
      };
      const manager = new XaiSubscriptionTokenManager();
      await expect(manager.getAccessToken(params)).rejects.toMatchObject({
        statusCode: 502,
      });
      // Nothing reached the issuer, so nothing was written or flagged.
      expect(issuer.calls).toEqual([]);
      expect(await readCredential(subscriptionKey.secretId)).toEqual(
        subscriptionKey.credential,
      );
      expect(
        (await LlmProviderApiKeyModel.findById(subscriptionKey.id))
          ?.requiresReauthentication,
      ).toBe(false);
      // The next caller presents the token for the first time.
      expect(await manager.getAccessToken(params)).toBe("at_1");
      expect(issuer.calls).toEqual(["rt_0"]);
    },
  );

  tokenTest(
    "does not call the issuer again when the transaction is retried after an issuer failure",
    async ({ subscriptionKey }) => {
      const issuer = stubSingleUseIssuer();
      const issuerFetch = globalThis.fetch;
      let tokenRequests = 0;
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string | URL, init?: RequestInit) => {
          if (String(url).endsWith("/oauth2/token")) {
            tokenRequests += 1;
            throw Object.assign(new TypeError("fetch failed"), {
              cause: Object.assign(new Error("read ECONNRESET"), {
                code: "ECONNRESET",
              }),
            });
          }
          return issuerFetch(url, init);
        }),
      );
      // The commit of the (empty) transaction loses its connection, so the
      // lock helper runs the callback a second time.
      lockFaults.failAfterRun = 1;
      try {
        await expect(
          new XaiSubscriptionTokenManager().getAccessToken({
            credential: subscriptionKey.credential,
            providerApiKeyId: subscriptionKey.id,
          }),
        ).rejects.toMatchObject({ statusCode: 502 });
      } finally {
        lockFaults.failAfterRun = 0;
      }
      expect(tokenRequests).toBe(1);
      expect(issuer.calls).toEqual([]);
    },
  );

  tokenTest(
    "answers 502 when the issuer's response body is cut off, without presenting the token again",
    async ({ subscriptionKey }) => {
      const issuer = stubSingleUseIssuer();
      const issuerFetch = globalThis.fetch;
      let cut = false;
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string | URL, init?: RequestInit) => {
          const response = await issuerFetch(url, init);
          if (cut || !String(url).endsWith("/oauth2/token")) {
            return response;
          }
          cut = true;
          // The headers arrived, so the issuer has rotated the token; the
          // body never completes.
          return new Response(
            new ReadableStream({
              pull(controller) {
                controller.error(new TypeError("terminated"));
              },
            }),
            { status: response.status, headers: response.headers },
          );
        }),
      );
      const innerFetch = vi.fn();
      const wrapped = createXaiSubscriptionFetch({
        credential: subscriptionKey.credential,
        providerApiKeyId: subscriptionKey.id,
        innerFetch,
      });
      const response = await wrapped(
        "https://cli-chat-proxy.grok.test/v1/chat/completions",
        { method: "POST", body: "{}" },
      );
      expect(response.status).toBe(502);
      expect(innerFetch).not.toHaveBeenCalled();
      // rt_0 was presented once and its rotation is lost; nothing on this
      // request asks the issuer again.
      expect(issuer.calls).toEqual(["rt_0"]);
      expect(await readCredential(subscriptionKey.secretId)).toEqual(
        subscriptionKey.credential,
      );
    },
  );

  test("reuses the access token stashed by an earlier validation of the same credential", async () => {
    const issuer = stubSingleUseIssuer();
    const manager = new XaiSubscriptionTokenManager();
    const credential = { refreshToken: "rt_0", userId: "test-account" };
    expect(await manager.getAccessToken({ credential })).toBe("at_1");
    // A second validation of the same body (an update route re-sending it)
    // must not redeem again: that would rotate and kill the token just stored.
    expect(await manager.getAccessToken({ credential })).toBe("at_1");
    expect(issuer.calls).toEqual(["rt_0"]);
  });
});

describe("createXaiSubscriptionFetch", () => {
  tokenTest(
    "adopts another replica's token on the single 401 retry without redeeming again",
    async ({ subscriptionKey }) => {
      const issuer = stubSingleUseIssuer();
      const replicaB = new XaiSubscriptionTokenManager();
      let inferenceCalls = 0;
      const innerFetch = vi.fn(
        async (_input: string | URL | Request, init?: RequestInit) => {
          inferenceCalls += 1;
          if (inferenceCalls === 1) {
            await replicaB.getAccessToken({
              credential: subscriptionKey.credential,
              providerApiKeyId: subscriptionKey.id,
              staleAccessToken: "at_1",
            });
            return new Response("expired", { status: 401 });
          }
          expect(new Headers(init?.headers).get("authorization")).toBe(
            "Bearer at_2",
          );
          return new Response("ok");
        },
      );
      const wrapped = createXaiSubscriptionFetch({
        credential: subscriptionKey.credential,
        providerApiKeyId: subscriptionKey.id,
        innerFetch,
      });
      expect(
        (
          await wrapped(
            "https://cli-chat-proxy.grok.test/v1/chat/completions",
            { method: "POST", body: "{}" },
          )
        ).status,
      ).toBe(200);
      expect(inferenceCalls).toBe(2);
      expect(issuer.calls).toEqual(["rt_0", "rt_1"]);
      expect(issuer.familyDead).toBe(false);
    },
  );

  tokenTest(
    "retries exactly once with a fresh bearer after a 401",
    async ({ subscriptionKey }) => {
      stubRedemptionFetch(({ index }) => ({
        access_token: `at_${index}`,
        expires_in: 3600,
      }));
      const innerFetch = vi
        .fn()
        .mockResolvedValueOnce(new Response("nope", { status: 401 }))
        .mockResolvedValue(new Response("ok"));

      const wrapped = createXaiSubscriptionFetch({
        credential: subscriptionKey.credential,
        providerApiKeyId: subscriptionKey.id,
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
    },
  );
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

  test("reports a Grok CLI version at or above the proxy minimum when no override is set", async () => {
    config.llm.xai.subscription.clientVersion = undefined;
    stubRedemptionFetch(() => ({
      access_token: "at_version",
      expires_in: 3600,
    }));
    const innerFetch = vi.fn().mockResolvedValue(new Response("ok"));
    const wrapped = createXaiSubscriptionFetch({
      credential: { refreshToken: "rt_version", userId: "x-user-123" },
      innerFetch,
    });

    await wrapped("https://cli-chat-proxy.grok.test/v1/chat/completions", {
      method: "POST",
      body: "{}",
    });

    const [, init] = innerFetch.mock.calls[0];
    const version = (init.headers as Headers).get("x-grok-client-version");
    expect((init.headers as Headers).get("user-agent")).toContain(
      `grok-build/${version}`,
    );
    // xAI answered 426 below 1.0.13 as of 2026-10-01.
    const [major, minor, patch] = String(version).split(".").map(Number);
    expect(major * 1_000_000 + minor * 1_000 + patch).toBeGreaterThanOrEqual(
      1_000_013,
    );
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

describe("ID-less validation rotation stash", () => {
  test("follows an observed rotation when the stashed access token is stale", async () => {
    const issuer = stubSingleUseIssuer();
    const manager = new XaiSubscriptionTokenManager();
    const credential = { refreshToken: "rt_0", userId: "validation-account" };
    await manager.getAccessToken({ credential });
    expect(manager.latestKnownCredential(credential)).toMatchObject({
      refreshToken: "rt_1",
      accessToken: "at_1",
      accessTokenExpiresAtMs: expect.any(Number),
    });
    // The stashed access token was rejected upstream: the successor refresh
    // token is redeemed, never the spent one the caller still holds.
    await manager.getAccessToken({ credential, staleAccessToken: "at_1" });
    expect(issuer.calls).toEqual(["rt_0", "rt_1"]);
    await manager.getAccessToken({
      credential: { ...credential, refreshToken: "rt_1" },
      staleAccessToken: "at_2",
    });
    expect(issuer.calls).toEqual(["rt_0", "rt_1", "rt_2"]);
    expect(issuer.familyDead).toBe(false);
  });
});
