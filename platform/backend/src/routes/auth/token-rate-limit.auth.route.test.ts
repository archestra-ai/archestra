import formbody from "@fastify/formbody";
import { afterEach, beforeEach, describe, expect, vi } from "vitest";
import { betterAuth } from "@/auth";
import { cacheManager } from "@/cache-manager";
import config from "@/config";
import {
  createFastifyInstance,
  type FastifyInstanceWithZod,
} from "@/fastify-instance";
import ManagedOauthClientModel from "@/models/managed-oauth-client";
import authRoutes from "@/routes/auth";
import { test } from "@/test";
import { setupTestCacheManager } from "@/test/cache-manager";

setupTestCacheManager();

describe("OAuth token endpoint rate limiting", () => {
  let apps: FastifyInstanceWithZod[];

  beforeEach(async () => {
    config.authRateLimitDisabled = false;
    config.api.trustProxy = false;
    apps = [createFastifyInstance(), createFastifyInstance()];
    for (const app of apps) {
      await app.register(formbody);
      await app.register(authRoutes);
    }
    vi.spyOn(betterAuth, "handler").mockImplementation(async () =>
      Response.json({ error: "invalid_grant" }, { status: 400 }),
    );
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(apps.map((app) => app.close()));
  });

  const request = (app: FastifyInstanceWithZod, clientId = "unknown") =>
    app.inject({
      method: "POST",
      url: "/api/auth/oauth2/token",
      remoteAddress: "192.0.2.1",
      payload: {
        grant_type: "client_credentials",
        client_id: clientId,
        client_secret: "invalid-credential",
      },
    });

  test("shares the budget across server instances and rejects before credential verification", async ({
    makeOrganization,
    makeUser,
  }) => {
    const organization = await makeOrganization();
    const user = await makeUser();
    const { oauthClient, clientSecret } = await ManagedOauthClientModel.create({
      organizationId: organization.id,
      authorId: user.id,
      name: "Rate limit test",
      scopes: ["mcp"],
    });
    for (let i = 0; i < 100; i++) {
      expect((await request(apps[i % 2], `unknown-${i}`)).statusCode).toBe(401);
    }
    // Observe the real verifier; a request rejected by the limiter must not call it.
    const verify = vi.spyOn(
      ManagedOauthClientModel,
      "findClientForCredentials",
    );
    const blocked = await apps[1].inject({
      method: "POST",
      url: "/api/auth/oauth2/token",
      remoteAddress: "192.0.2.1",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        authorization: `Basic ${Buffer.from(`${oauthClient.clientId}:${clientSecret}`).toString("base64")}`,
        "x-forwarded-for": "192.0.2.99",
      },
      payload: "grant_type=client_credentials",
    });
    expect(blocked.statusCode).toBe(429);
    expect(blocked.headers["retry-after"]).toMatch(/^\d+$/);
    expect(blocked.headers["cache-control"]).toBe("no-store");
    expect(blocked.json()).toMatchObject({ error: "temporarily_unavailable" });
    expect(verify).not.toHaveBeenCalled();

    const otherIp = await apps[0].inject({
      method: "POST",
      url: "/api/auth/oauth2/token",
      remoteAddress: "192.0.2.2",
      payload: {
        grant_type: "client_credentials",
        client_id: oauthClient.clientId,
        client_secret: clientSecret,
      },
    });
    expect(otherIp.statusCode).toBe(200);
    expect(verify).toHaveBeenCalledOnce();
  });

  test("admits only the remaining budget under concurrent requests", async () => {
    for (let i = 0; i < 98; i++) await request(apps[0]);
    const responses = await Promise.all(
      Array.from({ length: 8 }, (_, i) => request(apps[i % 2], `rotated-${i}`)),
    );
    expect(responses.filter((r) => r.statusCode === 401)).toHaveLength(2);
    expect(responses.filter((r) => r.statusCode === 429)).toHaveLength(6);
  });

  test("opens a new window after expiry without extending a blocked window", async () => {
    const start = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(start);
    for (let i = 0; i < 100; i++) await request(apps[0]);
    clock.mockReturnValue(start + 59_001);
    const blocked = await request(apps[1]);
    expect(blocked.statusCode).toBe(429);
    expect(blocked.headers["retry-after"]).toBe("1");
    clock.mockReturnValue(start + 60_000);
    expect((await request(apps[0])).statusCode).toBe(401);
  });

  test("limits other grants before forwarding and honors the explicit disable flag", async () => {
    for (let i = 0; i < 100; i++) await request(apps[0]);
    const payload = { grant_type: "authorization_code", code: "invalid-code" };
    const blocked = await apps[1].inject({
      method: "POST",
      url: "/api/auth/oauth2/token",
      remoteAddress: "192.0.2.1",
      payload,
    });
    expect(blocked.statusCode).toBe(429);
    expect(betterAuth.handler).not.toHaveBeenCalled();
    config.authRateLimitDisabled = true;
    const forwarded = await apps[1].inject({
      method: "POST",
      url: "/api/auth/oauth2/token",
      remoteAddress: "192.0.2.1",
      payload,
    });
    expect(forwarded.statusCode).toBe(400);
    expect(betterAuth.handler).toHaveBeenCalledOnce();
  });

  test("fails closed when shared rate-limit storage is unavailable", async () => {
    cacheManager.shutdown();
    expect((await request(apps[0])).statusCode).toBe(503);
  });
});
