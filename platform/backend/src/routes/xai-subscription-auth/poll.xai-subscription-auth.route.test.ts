import { vi } from "vitest";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { decodeXaiSubscriptionCredential } from "@/services/xai-subscription-credentials";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";

// cacheManager (used by the rate limiter) needs a live PostgreSQL connection
// that PGlite tests don't have; back it with the canonical Map-backed fake from
// src/__mocks__/cache-manager.ts (reset before every test).
vi.mock("@/cache-manager");

vi.mock("@/config", async () =>
  (await import("@/test/mocks/config")).configModuleMock({
    llm: {
      xai: {
        subscription: {
          issuer: "https://auth.x.ai",
          clientId: "test-xai-client-id",
          scopes: "openid offline_access api:access",
        },
      },
    },
  }),
);

const DISCOVERY_URL = "https://auth.x.ai/.well-known/openid-configuration";
const TOKEN_ENDPOINT = "https://auth.x.ai/oauth2/token";

/**
 * Answers the OIDC discovery request from the standard document and hands every
 * other request to `onToken`. Discovery is memoized per issuer for the process
 * lifetime, so tests assert on the token call rather than on discovery.
 */
function mockXaiFetch(onToken: () => Response) {
  const fetchMock = vi.fn(async (url: string | URL, _init?: RequestInit) => {
    if (String(url) === DISCOVERY_URL) {
      return Response.json({
        device_authorization_endpoint: "https://auth.x.ai/oauth2/device/code",
        token_endpoint: TOKEN_ENDPOINT,
      });
    }
    return onToken();
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function poll(app: FastifyInstanceWithZod) {
  return app.inject({
    method: "POST",
    url: "/api/xai-subscription-auth/device/poll",
    payload: { deviceCode: "device-123" },
  });
}

function idToken(claims: Record<string, unknown>): string {
  return [
    Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url"),
    Buffer.from(JSON.stringify(claims)).toString("base64url"),
    "signature",
  ].join(".");
}

describe("POST /api/xai-subscription-auth/device/poll", () => {
  let app: FastifyInstanceWithZod;
  let user: User;

  beforeEach(async ({ makeOrganization, makeUser }) => {
    const organization = await makeOrganization();
    user = await makeUser();

    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      (
        request as typeof request & { organizationId: string; user: User }
      ).organizationId = organization.id;
      (request as typeof request & { user: User }).user = user;
    });

    const { default: xaiSubscriptionAuthRoutes } = await import(
      "./xai-subscription-auth.routes"
    );
    await app.register(xaiSubscriptionAuthRoutes);
  });

  afterEach(async () => {
    await app.close();
    vi.unstubAllGlobals();
  });

  test("returns the encoded credential once the user has authorized", async () => {
    const fetchMock = mockXaiFetch(() =>
      Response.json({
        access_token: "xai-access-token",
        refresh_token: "xai-refresh-token",
        id_token: idToken({ sub: "x-user-123", email: "x@example.com" }),
        expires_in: 3600,
      }),
    );

    const response = await poll(app);

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.status).toBe("complete");
    // The credential is what the frontend stores as the xai provider key, so it
    // must round-trip through the decoder the proxy adapter uses.
    expect(decodeXaiSubscriptionCredential(body.credential)).toEqual({
      refreshToken: "xai-refresh-token",
      userId: "x-user-123",
      email: "x@example.com",
    });

    const tokenCall = fetchMock.mock.calls.find(
      ([url]) => String(url) === TOKEN_ENDPOINT,
    );
    const init = tokenCall?.[1] as
      | (RequestInit & { headers: Record<string, string> })
      | undefined;
    expect(init?.headers["content-type"]).toBe(
      "application/x-www-form-urlencoded",
    );
    const sent = init?.body as URLSearchParams;
    expect(sent.get("client_id")).toBe("test-xai-client-id");
    expect(sent.get("device_code")).toBe("device-123");
    expect(sent.get("grant_type")).toBe(
      "urn:ietf:params:oauth:grant-type:device_code",
    );
  });

  test("reports authorization_pending as pending", async () => {
    // RFC 8628 sends flow states as HTTP 400 with the error in the body.
    mockXaiFetch(() =>
      Response.json({ error: "authorization_pending" }, { status: 400 }),
    );

    const response = await poll(app);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "pending" });
  });

  test("relays slow_down so the client backs off", async () => {
    mockXaiFetch(() => Response.json({ error: "slow_down" }, { status: 400 }));

    const response = await poll(app);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "slow_down" });
  });

  test("400s when the device code expired before it was authorized", async () => {
    mockXaiFetch(() =>
      Response.json({ error: "expired_token" }, { status: 400 }),
    );

    const response = await poll(app);

    expect(response.statusCode).toBe(400);
    expect(response.json().error.message).toContain("expired");
  });

  test("400s when the user declined the sign-in", async () => {
    mockXaiFetch(() =>
      Response.json({ error: "access_denied" }, { status: 400 }),
    );

    const response = await poll(app);

    expect(response.statusCode).toBe(400);
  });

  test("502s when xAI grants no refresh token", async () => {
    // Without offline_access the key would die with the first access token, so
    // this must fail at connect time rather than produce a key that breaks later.
    mockXaiFetch(() => Response.json({ access_token: "xai-access-token" }));

    const response = await poll(app);

    expect(response.statusCode).toBe(502);
    expect(response.json().error.message).toContain("refresh token");
  });

  test("502s when xAI grants no usable account identity", async () => {
    mockXaiFetch(() =>
      Response.json({
        access_token: "xai-access-token",
        refresh_token: "xai-refresh-token",
      }),
    );

    const response = await poll(app);

    expect(response.statusCode).toBe(502);
    expect(response.json().error.message).toContain("account identity");
  });
});
