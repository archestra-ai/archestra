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

describe("POST /api/github-copilot-auth/device/start", () => {
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

  test("requests a device code from GitHub with the configured client id", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json({
        device_code: "device-123",
        user_code: "ABCD-1234",
        verification_uri: "https://github.com/login/device",
        interval: 5,
        expires_in: 899,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const response = await app.inject({
      method: "POST",
      url: "/api/github-copilot-auth/device/start",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      deviceCode: "device-123",
      userCode: "ABCD-1234",
      verificationUri: "https://github.com/login/device",
      interval: 5,
      expiresIn: 899,
    });

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe("https://github.com/login/device/code");
    expect(JSON.parse(init.body)).toEqual({
      client_id: expect.any(String),
      scope: "read:user",
    });
  });

  test("maps a GitHub failure to a 502", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("nope", { status: 503 })),
    );

    const response = await app.inject({
      method: "POST",
      url: "/api/github-copilot-auth/device/start",
    });

    expect(response.statusCode).toBe(502);
  });
});
