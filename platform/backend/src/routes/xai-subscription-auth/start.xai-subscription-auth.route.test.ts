import { vi } from "vitest";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";

// cacheManager (used by the rate limiter) needs a live PostgreSQL connection
// that PGlite tests don't have; back it with the canonical Map-backed fake from
// src/__mocks__/cache-manager.ts (reset before every test).
vi.mock("@/cache-manager");

// Pin the issuer/client id/scopes so a developer's local .env (which the test
// setup loads) can't leak into the asserted xAI URLs and bodies.
vi.mock("@/config", async () =>
  (await import("@/test/mocks/config")).configModuleMock({
    llm: {
      xai: {
        subscription: {
          issuer: "https://auth.x.ai",
          verificationOrigin: "https://accounts.x.ai",
          clientId: "test-xai-client-id",
          scopes: "openid offline_access api:access",
        },
      },
    },
  }),
);

const DISCOVERY_URL = "https://auth.x.ai/.well-known/openid-configuration";
const DEVICE_ENDPOINT = "https://auth.x.ai/oauth2/device/code";

/**
 * Answers the OIDC discovery request from the standard document and hands every
 * other request to `onDevice`. Discovery is memoized per issuer for the process
 * lifetime, so tests assert on the device call rather than on discovery.
 */
function mockXaiFetch(onDevice: () => Response) {
  const fetchMock = vi.fn(async (url: string | URL, _init?: RequestInit) => {
    if (String(url) === DISCOVERY_URL) {
      return Response.json({
        device_authorization_endpoint: DEVICE_ENDPOINT,
        token_endpoint: "https://auth.x.ai/oauth2/token",
      });
    }
    return onDevice();
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("POST /api/xai-subscription-auth/device/start", () => {
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

  test("requests a device code with a form-encoded body and the configured scopes", async () => {
    const fetchMock = mockXaiFetch(() =>
      Response.json({
        device_code: "device-123",
        user_code: "ABCD-1234",
        verification_uri: "https://accounts.x.ai/device",
        interval: 5,
        expires_in: 899,
      }),
    );

    const response = await app.inject({
      method: "POST",
      url: "/api/xai-subscription-auth/device/start",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      deviceCode: "device-123",
      userCode: "ABCD-1234",
      verificationUri: "https://accounts.x.ai/device",
      interval: 5,
      expiresIn: 899,
    });

    const deviceCall = fetchMock.mock.calls.find(
      ([url]) => String(url) === DEVICE_ENDPOINT,
    );
    expect(deviceCall).toBeDefined();
    const init = deviceCall?.[1] as
      | (RequestInit & { headers: Record<string, string> })
      | undefined;
    expect(init?.headers["content-type"]).toBe(
      "application/x-www-form-urlencoded",
    );
    expect(init?.redirect).toBe("manual");
    const body = init?.body as URLSearchParams;
    expect(body.get("client_id")).toBe("test-xai-client-id");
    expect(body.get("scope")).toBe("openid offline_access api:access");
  });

  test("prefers the one-click verification URI when xAI sends one", async () => {
    mockXaiFetch(() =>
      Response.json({
        device_code: "device-123",
        user_code: "ABCD-1234",
        verification_uri: "https://accounts.x.ai/device",
        verification_uri_complete:
          "https://accounts.x.ai/device?user_code=ABCD-1234",
        interval: 5,
        expires_in: 899,
      }),
    );

    const response = await app.inject({
      method: "POST",
      url: "/api/xai-subscription-auth/device/start",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().verificationUri).toBe(
      "https://accounts.x.ai/device?user_code=ABCD-1234",
    );
  });

  test("defaults the poll interval and lifetime when xAI omits them", async () => {
    mockXaiFetch(() =>
      Response.json({
        device_code: "device-123",
        user_code: "ABCD-1234",
        verification_uri: "https://accounts.x.ai/device",
      }),
    );

    const response = await app.inject({
      method: "POST",
      url: "/api/xai-subscription-auth/device/start",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ interval: 5, expiresIn: 900 });
  });

  test.each([
    "javascript:alert(document.domain)",
    "data:text/html,phishing",
    "http://accounts.x.ai/device",
    "https://accounts.x.ai.evil.example/device",
    "https://evil.example/device",
  ])("rejects an untrusted verification URL: %s", async (verificationUri) => {
    mockXaiFetch(() =>
      Response.json({
        device_code: "device-123",
        user_code: "ABCD-1234",
        verification_uri: verificationUri,
      }),
    );

    const response = await app.inject({
      method: "POST",
      url: "/api/xai-subscription-auth/device/start",
    });

    expect(response.statusCode).toBe(502);
    expect(response.json().error.message).toMatch(/untrusted verification URL/);
  });

  test("maps an xAI failure to a 502", async () => {
    mockXaiFetch(() => new Response("nope", { status: 503 }));

    const response = await app.inject({
      method: "POST",
      url: "/api/xai-subscription-auth/device/start",
    });

    expect(response.statusCode).toBe(502);
  });
});
