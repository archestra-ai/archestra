import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { betterAuth } from "@/auth";
import { cacheManager } from "@/cache-manager";
import config from "@/config";
import {
  createFastifyInstance,
  type FastifyInstanceWithZod,
} from "@/fastify-instance";
import authRoutes from "@/routes/auth";
import { setupTestCacheManager } from "@/test/cache-manager";

setupTestCacheManager();

describe("auth route rate limiting", () => {
  let app: FastifyInstanceWithZod;

  beforeEach(async () => {
    config.authRateLimitDisabled = false;
    config.api.trustProxy = false;
    app = createFastifyInstance();
    await app.register(authRoutes);
    vi.spyOn(betterAuth, "handler").mockImplementation(async () =>
      Response.json({ message: "Invalid email or password" }, { status: 401 }),
    );
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await app.close();
  });

  const signIn = (remoteAddress = "192.0.2.10") =>
    app.inject({
      method: "POST",
      url: "/api/auth/sign-in/email",
      remoteAddress,
      payload: { email: "someone@example.com", password: "wrong" },
    });

  test("rejects sign-in attempts past the per-IP budget before calling better-auth", async () => {
    for (let i = 0; i < 60; i++) {
      expect((await signIn()).statusCode).toBe(401);
    }
    const blocked = await signIn();
    expect(blocked.statusCode).toBe(429);
    expect(blocked.headers["retry-after"]).toMatch(/^\d+$/);
    expect(blocked.json().error.message).toMatch(/Too many sign-in attempts/);
    expect(betterAuth.handler).toHaveBeenCalledTimes(60);

    // The budget is per IP, so another client is unaffected.
    expect((await signIn("192.0.2.11")).statusCode).toBe(401);
  });

  test("leaves session reads on the catch-all route unthrottled", async () => {
    for (let i = 0; i < 65; i++) {
      const response = await app.inject({
        method: "GET",
        url: "/api/auth/get-session",
        remoteAddress: "192.0.2.20",
      });
      expect(response.statusCode).toBe(401);
    }
    expect(betterAuth.handler).toHaveBeenCalledTimes(65);
  });

  test("honors the explicit disable flag", async () => {
    config.authRateLimitDisabled = true;
    for (let i = 0; i < 65; i++) {
      expect((await signIn("192.0.2.30")).statusCode).toBe(401);
    }
  });

  test("fails closed when shared rate-limit storage is unavailable", async () => {
    cacheManager.shutdown();
    const response = await signIn("192.0.2.40");
    expect(response.statusCode).toBe(503);
    expect(betterAuth.handler).not.toHaveBeenCalled();
  });
});
