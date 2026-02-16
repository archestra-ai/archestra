import Fastify from "fastify";
import config from "@/config";
import { afterEach, beforeEach, describe, expect, it } from "@/test";
import { ApiError } from "@/types";
import {
  enterpriseLicenseMiddleware,
  isEnterpriseOnlyRoute,
} from "./middleware";

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
      fastify.get("/api/identity-providers", async () => ({ success: true }));
      fastify.get("/api/identity-providers/public", async () => ({
        providers: [],
      }));
      fastify.post("/api/identity-providers", async () => ({ created: true }));
      fastify.get("/api/identity-providers/:id", async () => ({
        provider: {},
      }));

      // Add a non-SSO route to verify it's not blocked
      fastify.get("/api/profiles", async () => ({ profiles: [] }));

      await fastify.ready();
    });

    it("should return 403 for GET /api/identity-providers", async () => {
      const response = await fastify.inject({
        method: "GET",
        url: "/api/identity-providers",
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

    it("should return 403 for GET /api/identity-providers/public", async () => {
      const response = await fastify.inject({
        method: "GET",
        url: "/api/identity-providers/public",
      });

      expect(response.statusCode).toBe(403);
    });

    it("should return 403 for POST /api/identity-providers", async () => {
      const response = await fastify.inject({
        method: "POST",
        url: "/api/identity-providers",
        payload: {},
      });

      expect(response.statusCode).toBe(403);
    });

    it("should return 403 for GET /api/identity-providers/:id", async () => {
      const response = await fastify.inject({
        method: "GET",
        url: "/api/identity-providers/some-id",
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

      fastify.get("/api/identity-providers", async () => ({ success: true }));
      fastify.get("/api/identity-providers/public", async () => ({
        providers: [],
      }));
      fastify.post("/api/identity-providers", async () => ({ created: true }));

      await fastify.ready();
    });

    it("should allow GET /api/identity-providers", async () => {
      const response = await fastify.inject({
        method: "GET",
        url: "/api/identity-providers",
      });

      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.payload)).toEqual({ success: true });
    });

    it("should allow GET /api/identity-providers/public", async () => {
      const response = await fastify.inject({
        method: "GET",
        url: "/api/identity-providers/public",
      });

      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.payload)).toEqual({ providers: [] });
    });

    it("should allow POST /api/identity-providers", async () => {
      const response = await fastify.inject({
        method: "POST",
        url: "/api/identity-providers",
        payload: {},
      });

      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.payload)).toEqual({ created: true });
    });
  });

  describe("team external groups routes (SSO Team Sync)", () => {
    describe("when enterprise license is NOT activated", () => {
      beforeEach(async () => {
        setEnterpriseLicenseActivated(false);

        fastify = createTestFastify();
        await fastify.register(enterpriseLicenseMiddleware);

        // Team external groups routes
        fastify.get("/api/teams/:id/external-groups", async () => ({
          groups: [],
        }));
        fastify.post("/api/teams/:id/external-groups", async () => ({
          created: true,
        }));
        fastify.delete("/api/teams/:id/external-groups/:groupId", async () => ({
          success: true,
        }));

        // Regular team routes should still work
        fastify.get("/api/teams", async () => ({ teams: [] }));
        fastify.get("/api/teams/:id", async () => ({ team: {} }));

        await fastify.ready();
      });

      it("should return 403 for GET /api/teams/:id/external-groups", async () => {
        const response = await fastify.inject({
          method: "GET",
          url: "/api/teams/some-team-id/external-groups",
        });

        expect(response.statusCode).toBe(403);
        expect(JSON.parse(response.payload)).toEqual({
          error: {
            message:
              "Team Sync is an enterprise feature. Please contact sales@archestra.ai to enable it.",
            type: "api_authorization_error",
          },
        });
      });

      it("should return 403 for POST /api/teams/:id/external-groups", async () => {
        const response = await fastify.inject({
          method: "POST",
          url: "/api/teams/some-team-id/external-groups",
          payload: { groupIdentifier: "engineering" },
        });

        expect(response.statusCode).toBe(403);
      });

      it("should return 403 for DELETE /api/teams/:id/external-groups/:groupId", async () => {
        const response = await fastify.inject({
          method: "DELETE",
          url: "/api/teams/some-team-id/external-groups/some-group-id",
        });

        expect(response.statusCode).toBe(403);
      });

      it("should NOT block regular team routes", async () => {
        const response = await fastify.inject({
          method: "GET",
          url: "/api/teams",
        });

        expect(response.statusCode).toBe(200);
        expect(JSON.parse(response.payload)).toEqual({ teams: [] });
      });

      it("should NOT block GET /api/teams/:id", async () => {
        const response = await fastify.inject({
          method: "GET",
          url: "/api/teams/some-team-id",
        });

        expect(response.statusCode).toBe(200);
        expect(JSON.parse(response.payload)).toEqual({ team: {} });
      });
    });

    describe("when enterprise license IS activated", () => {
      beforeEach(async () => {
        setEnterpriseLicenseActivated(true);

        fastify = createTestFastify();
        await fastify.register(enterpriseLicenseMiddleware);

        fastify.get("/api/teams/:id/external-groups", async () => ({
          groups: [],
        }));
        fastify.post("/api/teams/:id/external-groups", async () => ({
          created: true,
        }));
        fastify.delete("/api/teams/:id/external-groups/:groupId", async () => ({
          success: true,
        }));

        await fastify.ready();
      });

      it("should allow GET /api/teams/:id/external-groups", async () => {
        const response = await fastify.inject({
          method: "GET",
          url: "/api/teams/some-team-id/external-groups",
        });

        expect(response.statusCode).toBe(200);
        expect(JSON.parse(response.payload)).toEqual({ groups: [] });
      });

      it("should allow POST /api/teams/:id/external-groups", async () => {
        const response = await fastify.inject({
          method: "POST",
          url: "/api/teams/some-team-id/external-groups",
          payload: { groupIdentifier: "engineering" },
        });

        expect(response.statusCode).toBe(200);
        expect(JSON.parse(response.payload)).toEqual({ created: true });
      });

      it("should allow DELETE /api/teams/:id/external-groups/:groupId", async () => {
        const response = await fastify.inject({
          method: "DELETE",
          url: "/api/teams/some-team-id/external-groups/some-group-id",
        });

        expect(response.statusCode).toBe(200);
        expect(JSON.parse(response.payload)).toEqual({ success: true });
      });
    });
  });
});

describe("isEnterpriseOnlyRoute", () => {
  it("should return true for SSO provider routes", () => {
    expect(isEnterpriseOnlyRoute("/api/identity-providers")).toBe(true);
    expect(isEnterpriseOnlyRoute("/api/identity-providers/public")).toBe(true);
    expect(isEnterpriseOnlyRoute("/api/identity-providers/some-id")).toBe(true);
  });

  it("should return true for team external groups routes", () => {
    expect(isEnterpriseOnlyRoute("/api/teams/team-123/external-groups")).toBe(
      true,
    );
    expect(
      isEnterpriseOnlyRoute("/api/teams/team-123/external-groups/group-456"),
    ).toBe(true);
  });

  it("should return false for regular team routes", () => {
    expect(isEnterpriseOnlyRoute("/api/teams")).toBe(false);
    expect(isEnterpriseOnlyRoute("/api/teams/team-123")).toBe(false);
    expect(isEnterpriseOnlyRoute("/api/teams/team-123/members")).toBe(false);
    expect(isEnterpriseOnlyRoute("/api/teams/team-123/members/user-456")).toBe(
      false,
    );
  });

  it("should return false for other routes", () => {
    expect(isEnterpriseOnlyRoute("/api/profiles")).toBe(false);
    expect(isEnterpriseOnlyRoute("/api/auth/session")).toBe(false);
    expect(isEnterpriseOnlyRoute("/health")).toBe(false);
  });
});
