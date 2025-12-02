import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import config from "@/config";
import { ApiError } from "@/types/api";
import { enterpriseLicenseMiddleware } from "./middleware";

/**
 * Creates a Fastify instance with the same error handler as the production server
 */
const createTestFastify = () => {
  const fastify = Fastify();

  // Add the same error handler as server.ts
  fastify.setErrorHandler<ApiError | Error>((error, _request, reply) => {
    if (error instanceof ApiError) {
      const { statusCode, message, type } = error;
      return reply.status(statusCode).send({
        error: {
          message,
          type,
        },
      });
    }

    const message = error.message || "Internal server error";
    return reply.status(500).send({
      error: {
        message,
        type: "api_internal_server_error",
      },
    });
  });

  return fastify;
};

describe.sequential("enterpriseLicenseMiddleware", () => {
  let fastify: ReturnType<typeof createTestFastify>;
  const originalValue = config.enterpriseLicenseActivated;

  const setEnterpriseLicenseActivated = (value: boolean) => {
    Object.defineProperty(config, "enterpriseLicenseActivated", {
      value,
      writable: true,
      configurable: true,
    });
  };

  afterEach(async () => {
    if (fastify) {
      await fastify.close();
    }
    // Restore original value
    setEnterpriseLicenseActivated(originalValue);
  });

  describe("when enterprise license is NOT activated", () => {
    beforeEach(async () => {
      setEnterpriseLicenseActivated(false);

      fastify = createTestFastify();
      await fastify.register(enterpriseLicenseMiddleware);

      // Add test routes for SSO providers
      fastify.get("/api/sso-providers", async () => ({ success: true }));
      fastify.get("/api/sso-providers/public", async () => ({ providers: [] }));
      fastify.post("/api/sso-providers", async () => ({ created: true }));
      fastify.get("/api/sso-providers/:id", async () => ({ provider: {} }));

      // Add a non-SSO route to verify it's not blocked
      fastify.get("/api/profiles", async () => ({ profiles: [] }));

      await fastify.ready();
    });

    it("should return 403 for GET /api/sso-providers", async () => {
      const response = await fastify.inject({
        method: "GET",
        url: "/api/sso-providers",
      });

      expect(response.statusCode).toBe(403);
      expect(JSON.parse(response.payload)).toEqual({
        error: {
          message:
            "SSO is an enterprise feature. Please contact sales@archestra.ai to enable it.",
          type: "api_authorization_error",
        },
      });
    });

    it("should return 403 for GET /api/sso-providers/public", async () => {
      const response = await fastify.inject({
        method: "GET",
        url: "/api/sso-providers/public",
      });

      expect(response.statusCode).toBe(403);
    });

    it("should return 403 for POST /api/sso-providers", async () => {
      const response = await fastify.inject({
        method: "POST",
        url: "/api/sso-providers",
        payload: {},
      });

      expect(response.statusCode).toBe(403);
    });

    it("should return 403 for GET /api/sso-providers/:id", async () => {
      const response = await fastify.inject({
        method: "GET",
        url: "/api/sso-providers/some-id",
      });

      expect(response.statusCode).toBe(403);
    });

    it("should NOT block non-SSO routes", async () => {
      const response = await fastify.inject({
        method: "GET",
        url: "/api/profiles",
      });

      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.payload)).toEqual({ profiles: [] });
    });
  });

  describe("when enterprise license IS activated", () => {
    beforeEach(async () => {
      setEnterpriseLicenseActivated(true);

      fastify = createTestFastify();
      await fastify.register(enterpriseLicenseMiddleware);

      fastify.get("/api/sso-providers", async () => ({ success: true }));
      fastify.get("/api/sso-providers/public", async () => ({ providers: [] }));
      fastify.post("/api/sso-providers", async () => ({ created: true }));

      await fastify.ready();
    });

    it("should allow GET /api/sso-providers", async () => {
      const response = await fastify.inject({
        method: "GET",
        url: "/api/sso-providers",
      });

      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.payload)).toEqual({ success: true });
    });

    it("should allow GET /api/sso-providers/public", async () => {
      const response = await fastify.inject({
        method: "GET",
        url: "/api/sso-providers/public",
      });

      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.payload)).toEqual({ providers: [] });
    });

    it("should allow POST /api/sso-providers", async () => {
      const response = await fastify.inject({
        method: "POST",
        url: "/api/sso-providers",
        payload: {},
      });

      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.payload)).toEqual({ created: true });
    });
  });
});
