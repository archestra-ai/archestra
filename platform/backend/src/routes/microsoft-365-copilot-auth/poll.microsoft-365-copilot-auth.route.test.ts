import { vi } from "vitest";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";

// cacheManager (used by the rate limiter) needs a live PostgreSQL connection
// that PGlite tests don't have; back it with the canonical Map-backed fake from
// src/__mocks__/cache-manager.ts (reset before every test).
vi.mock("@/cache-manager");

// There is no community client id for the Entra device flow, so the config
// default is empty; the routes 400 without one. Give the tests a configured id,
// and pin the tenant/auth host so a developer's local .env (which the test
// setup loads) can't leak into the asserted Entra URLs.
vi.mock("@/config", async () =>
  (await import("@/test/mocks/config")).configModuleMock({
    llm: {
      "microsoft-365-copilot": {
        clientId: "test-entra-client-id",
        tenantId: "organizations",
        authBaseUrl: "https://login.microsoftonline.com",
      },
    },
  }),
);

describe("POST /api/microsoft-365-copilot-auth/device/poll", () => {
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

    const { default: microsoft365CopilotAuthRoutes } = await import(
      "./microsoft-365-copilot-auth.routes"
    );
    await app.register(microsoft365CopilotAuthRoutes);
  });

  afterEach(async () => {
    await app.close();
    vi.unstubAllGlobals();
  });

  function poll() {
    return app.inject({
      method: "POST",
      url: "/api/microsoft-365-copilot-auth/device/poll",
      payload: { deviceCode: "device-123" },
    });
  }

  test("returns pending while the user has not authorized yet (Entra reports it as HTTP 400)", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          Response.json({ error: "authorization_pending" }, { status: 400 }),
        ),
    );

    const response = await poll();
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "pending" });
  });

  test("relays slow_down so the frontend can back off", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          Response.json({ error: "slow_down" }, { status: 400 }),
        ),
    );

    const response = await poll();
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "slow_down" });
  });

  test("returns the refresh token once authorized, posting the device code with the grant type", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json({
        access_token: "eyJ-access",
        refresh_token: "entra-refresh-secret",
        expires_in: 3600,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const response = await poll();
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      status: "complete",
      refreshToken: "entra-refresh-secret",
    });

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe(
      "https://login.microsoftonline.com/organizations/oauth2/v2.0/token",
    );
    expect(init.headers["content-type"]).toBe(
      "application/x-www-form-urlencoded",
    );
    const body = init.body as URLSearchParams;
    expect(body.get("client_id")).toBe("test-entra-client-id");
    expect(body.get("device_code")).toBe("device-123");
    expect(body.get("grant_type")).toBe(
      "urn:ietf:params:oauth:grant-type:device_code",
    );
  });

  test("502s when Entra returns tokens without a refresh token (offline_access missing)", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          Response.json({ access_token: "eyJ-access", expires_in: 3600 }),
        ),
    );

    const response = await poll();
    expect(response.statusCode).toBe(502);
    expect(response.json().error.message).toContain("offline_access");
  });

  test("400s when the device code expired or the user declined", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          Response.json({ error: "expired_token" }, { status: 400 }),
        ),
    );
    expect((await poll()).statusCode).toBe(400);

    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          Response.json({ error: "authorization_declined" }, { status: 400 }),
        ),
    );
    expect((await poll()).statusCode).toBe(400);
  });

  test("502s on unexpected Entra errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          Response.json({ error: "invalid_client" }, { status: 401 }),
        ),
    );
    expect((await poll()).statusCode).toBe(502);
  });
});
