import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { betterAuth } from "@/auth";
import config from "@/config";
import {
  createFastifyInstance,
  type FastifyInstanceWithZod,
} from "@/fastify-instance";
import authRoutes from "@/routes/auth";
import { setupTestCacheManager } from "@/test/cache-manager";

setupTestCacheManager();

/**
 * Browser sign-ins reach the backend through the frontend's `/api/auth/*`
 * handler, which calls the API over loopback. With the default (untrusted)
 * proxy setting every user therefore arrives from the same socket address,
 * so failed attempts by one user must not block sign-in for everyone else.
 */
describe("sign-in through the frontend auth proxy", () => {
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

  const signInViaFrontendProxy = (params: {
    clientIp: string;
    email: string;
  }) =>
    app.inject({
      method: "POST",
      url: "/api/auth/sign-in/email",
      remoteAddress: "127.0.0.1",
      headers: { "x-forwarded-for": params.clientIp },
      payload: { email: params.email, password: "wrong" },
    });

  test("one user's failed attempts do not lock out other users", async () => {
    for (let i = 0; i < 70; i++) {
      await signInViaFrontendProxy({
        clientIp: "198.51.100.7",
        email: "someone@example.com",
      });
    }

    const otherUser = await signInViaFrontendProxy({
      clientIp: "203.0.113.42",
      email: "colleague@example.com",
    });

    expect(otherUser.statusCode).toBe(401);
    expect(betterAuth.handler).toHaveBeenCalledTimes(71);
  });
});
