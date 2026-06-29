import { vi } from "vitest";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";

// cacheManager (used by the rate limiter) needs a live PostgreSQL connection
// that PGlite tests don't have; back it with a Map (same convention as
// script.connection-setup.route.test.ts).
const mockCache = new Map<string, unknown>();
vi.mock("@/cache-manager", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/cache-manager")>();
  return {
    ...original,
    cacheManager: {
      get: vi.fn(async (key: string) => mockCache.get(key)),
      set: vi.fn(async (key: string, value: unknown) => {
        mockCache.set(key, value);
        return true;
      }),
      delete: vi.fn(async (key: string) => mockCache.delete(key)),
    },
  };
});

describe("POST /api/github-copilot-auth/device/poll", () => {
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

    const { default: githubCopilotAuthRoutes } = await import(
      "./github-copilot-auth.routes"
    );
    await app.register(githubCopilotAuthRoutes);
  });

  afterEach(async () => {
    await app.close();
    vi.unstubAllGlobals();
  });

  function poll() {
    return app.inject({
      method: "POST",
      url: "/api/github-copilot-auth/device/poll",
      payload: { deviceCode: "device-123" },
    });
  }

  test("returns pending while the user has not authorized yet", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(Response.json({ error: "authorization_pending" })),
    );

    const response = await poll();
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "pending" });
  });

  test("relays slow_down so the frontend can back off", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(Response.json({ error: "slow_down" })),
    );

    const response = await poll();
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "slow_down" });
  });

  test("returns the access token once authorized, posting the device code with the grant type", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(Response.json({ access_token: "gho_secret" }));
    vi.stubGlobal("fetch", fetchMock);

    const response = await poll();
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      status: "complete",
      accessToken: "gho_secret",
    });

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe("https://github.com/login/oauth/access_token");
    expect(JSON.parse(init.body)).toEqual({
      client_id: expect.any(String),
      device_code: "device-123",
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    });
  });

  test("400s when the device code expired or the user declined", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(Response.json({ error: "expired_token" })),
    );
    expect((await poll()).statusCode).toBe(400);

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(Response.json({ error: "access_denied" })),
    );
    expect((await poll()).statusCode).toBe(400);
  });

  test("502s on unexpected GitHub errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          Response.json({ error: "incorrect_client_credentials" }),
        ),
    );
    expect((await poll()).statusCode).toBe(502);
  });
});
