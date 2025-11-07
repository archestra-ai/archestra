import type { FastifyReply, FastifyRequest } from "fastify";
import { describe, expect, it, vi } from "vitest";
import { Authnz, authPlugin } from "./fastify-plugin";

describe("Authnz", () => {
  const authnz = new Authnz();

  describe("shouldSkipAuthCheck", () => {
    it("should skip auth for ACME challenge paths", async () => {
      const mockRequest = {
        url: "/.well-known/acme-challenge/test-token",
        method: "GET",
        headers: {},
      } as FastifyRequest;

      const mockReply = {
        status: vi.fn().mockReturnThis(),
        send: vi.fn(),
      } as unknown as FastifyReply;

      // The middleware should not call reply.status() for ACME challenge paths
      await authnz.handle(mockRequest, mockReply);

      expect(mockReply.status).not.toHaveBeenCalled();
      expect(mockReply.send).not.toHaveBeenCalled();
    });

    it("should skip auth for various ACME challenge token formats", async () => {
      const acmeUrls = [
        "/.well-known/acme-challenge/",
        "/.well-known/acme-challenge/simple-token",
        "/.well-known/acme-challenge/complex-token-with-numbers-123",
        "/.well-known/acme-challenge/very_long_token_with_underscores_and_hyphens-123-456_789",
      ];

      for (const url of acmeUrls) {
        const mockRequest = {
          url,
          method: "GET",
          headers: {},
        } as FastifyRequest;

        const mockReply = {
          status: vi.fn().mockReturnThis(),
          send: vi.fn(),
        } as unknown as FastifyReply;

        await authnz.handle(mockRequest, mockReply);

        expect(mockReply.status).not.toHaveBeenCalled();
        expect(mockReply.send).not.toHaveBeenCalled();
      }
    });

    it("should skip auth for OPTIONS and HEAD requests", async () => {
      const methods = ["OPTIONS", "HEAD"];

      for (const method of methods) {
        const mockRequest = {
          url: "/some/protected/path",
          method,
          headers: {},
        } as FastifyRequest;

        const mockReply = {
          status: vi.fn().mockReturnThis(),
          send: vi.fn(),
        } as unknown as FastifyReply;

        await authnz.handle(mockRequest, mockReply);

        expect(mockReply.status).not.toHaveBeenCalled();
        expect(mockReply.send).not.toHaveBeenCalled();
      }
    });

    it("should skip auth for existing whitelisted paths", async () => {
      const whitelistedPaths = [
        "/api/auth/session",
        "/v1/openai/completions",
        "/v1/anthropic/messages",
        "/v1/gemini/generate",
        "/openapi.json",
        "/health",
        "/api/features",
      ];

      for (const url of whitelistedPaths) {
        const mockRequest = {
          url,
          method: "GET",
          headers: {},
        } as FastifyRequest;

        const mockReply = {
          status: vi.fn().mockReturnThis(),
          send: vi.fn(),
        } as unknown as FastifyReply;

        await authnz.handle(mockRequest, mockReply);

        expect(mockReply.status).not.toHaveBeenCalled();
        expect(mockReply.send).not.toHaveBeenCalled();
      }
    });

    it("should NOT skip auth for similar but different paths", async () => {
      const protectedPaths = [
        "/.well-known/something-else",
        "/.well-known-acme-challenge/test", // missing slash
        "/well-known/acme-challenge/test", // missing leading dot
        "/api/protected-endpoint",
        "/metrics",
      ];

      for (const url of protectedPaths) {
        const mockRequest = {
          url,
          method: "GET",
          headers: {},
          routeOptions: {
            schema: {
              operationId: "SomeProtectedRoute",
            },
          },
        } as FastifyRequest;

        const mockReply = {
          status: vi.fn().mockReturnThis(),
          send: vi.fn(),
        } as unknown as FastifyReply;

        await authnz.handle(mockRequest, mockReply);

        // Should return 401 for unauthenticated requests to protected paths
        expect(mockReply.status).toHaveBeenCalledWith(401);
      }
    });
  });
});

describe("authPlugin", () => {
  const authnz = new Authnz();
  const mockAuth = {
    api: {
      getSession: vi.fn(),
      verifyApiKey: vi.fn(),
      hasPermission: vi.fn(),
    },
  };

  // Mock the auth module
  vi.mock("@/auth", () => ({
    auth: mockAuth,
  }));

  // Mock getUserFromRequest utility
  vi.mock("@/utils", () => ({
    getUserFromRequest: vi.fn(),
  }));

  // Mock UserModel
  vi.mock("@/models", () => ({
    UserModel: {
      getUserById: vi.fn(),
      getOrganizationId: vi.fn(),
    },
  }));

  // Mock internal JWT verification
  vi.mock("@/utils/internal-jwt", () => ({
    verifyInternalJwt: vi.fn(),
  }));

  // Mock config
  vi.mock("@/config", () => ({
    default: {
      mcpGateway: {
        endpoint: "/v1/mcp",
      },
    },
  }));

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("authentication", () => {
    it("should allow authenticated session users", async () => {
      mockAuth.api.getSession.mockResolvedValue({
        user: { id: "user1" },
        session: { activeOrganizationId: "org1" },
      });
      mockAuth.api.hasPermission.mockResolvedValue({
        success: true,
        error: null,
      });

      const mockRequest = {
        url: "/api/agents",
        method: "GET",
        headers: {},
        routeOptions: {
          schema: { operationId: "getAgents" },
        },
      } as FastifyRequest;

      const mockReply = {
        status: vi.fn().mockReturnThis(),
        send: vi.fn(),
      } as unknown as FastifyReply;

      await authnz.handle(mockRequest, mockReply);

      expect(mockReply.status).not.toHaveBeenCalled();
      expect(mockReply.send).not.toHaveBeenCalled();
    });

    it("should allow valid API key authentication", async () => {
      mockAuth.api.getSession.mockRejectedValue(new Error("No session"));
      mockAuth.api.verifyApiKey.mockResolvedValue({ valid: true });

      const mockRequest = {
        url: "/api/agents",
        method: "GET",
        headers: { authorization: "Bearer api-key-123" },
        routeOptions: {
          schema: { operationId: "getAgents" },
        },
      } as FastifyRequest;

      const mockReply = {
        status: vi.fn().mockReturnThis(),
        send: vi.fn(),
      } as unknown as FastifyReply;

      await authnz.handle(mockRequest, mockReply);

      expect(mockAuth.api.verifyApiKey).toHaveBeenCalledWith({
        body: { key: "Bearer api-key-123" },
      });
      expect(mockReply.status).not.toHaveBeenCalled();
    });

    it("should return 401 for invalid session", async () => {
      mockAuth.api.getSession.mockResolvedValue(null);

      const mockRequest = {
        url: "/api/agents",
        method: "GET",
        headers: {},
        routeOptions: {
          schema: { operationId: "getAgents" },
        },
      } as FastifyRequest;

      const mockReply = {
        status: vi.fn().mockReturnThis(),
        send: vi.fn(),
      } as unknown as FastifyReply;

      await authnz.handle(mockRequest, mockReply);

      expect(mockReply.status).toHaveBeenCalledWith(401);
      expect(mockReply.send).toHaveBeenCalledWith({
        error: {
          message: "Unauthenticated",
          type: "unauthenticated",
        },
      });
    });

    it("should return 401 for invalid API key", async () => {
      mockAuth.api.getSession.mockRejectedValue(new Error("No session"));
      mockAuth.api.verifyApiKey.mockResolvedValue({ valid: false });

      const mockRequest = {
        url: "/api/agents",
        method: "GET",
        headers: { authorization: "Bearer invalid-key" },
        routeOptions: {
          schema: { operationId: "getAgents" },
        },
      } as FastifyRequest;

      const mockReply = {
        status: vi.fn().mockReturnThis(),
        send: vi.fn(),
      } as unknown as FastifyReply;

      await authnz.handle(mockRequest, mockReply);

      expect(mockReply.status).toHaveBeenCalledWith(401);
    });
  });

  describe("authorization", () => {
    it("should return 403 for insufficient permissions", async () => {
      mockAuth.api.getSession.mockResolvedValue({
        user: { id: "user1" },
        session: { activeOrganizationId: "org1" },
      });
      mockAuth.api.hasPermission.mockResolvedValue({
        success: false,
        error: new Error("Insufficient permissions"),
      });

      const mockRequest = {
        url: "/api/agents",
        method: "POST",
        headers: {},
        routeOptions: {
          schema: { operationId: "createAgent" },
        },
      } as FastifyRequest;

      const mockReply = {
        status: vi.fn().mockReturnThis(),
        send: vi.fn(),
      } as unknown as FastifyReply;

      await authnz.handle(mockRequest, mockReply);

      expect(mockReply.status).toHaveBeenCalledWith(403);
      expect(mockReply.send).toHaveBeenCalledWith({
        error: {
          message: "Insufficient permissions",
          type: "forbidden",
        },
      });
    });

    it("should return 403 for routes without operationId", async () => {
      mockAuth.api.getSession.mockResolvedValue({
        user: { id: "user1" },
        session: { activeOrganizationId: "org1" },
      });

      const mockRequest = {
        url: "/api/unknown",
        method: "GET",
        headers: {},
        routeOptions: {
          schema: {}, // No operationId
        },
      } as FastifyRequest;

      const mockReply = {
        status: vi.fn().mockReturnThis(),
        send: vi.fn(),
      } as unknown as FastifyReply;

      await authnz.handle(mockRequest, mockReply);

      expect(mockReply.status).toHaveBeenCalledWith(403);
      expect(mockReply.send).toHaveBeenCalledWith({
        error: {
          message: "Forbidden, routeId not found",
          type: "forbidden",
        },
      });
    });

    it("should allow API keys for permission checks that fail due to organization context", async () => {
      mockAuth.api.getSession.mockRejectedValue(new Error("No organization"));
      mockAuth.api.hasPermission.mockRejectedValue(
        new Error("No organization context"),
      );
      mockAuth.api.verifyApiKey.mockResolvedValue({ valid: true });

      const mockRequest = {
        url: "/api/agents",
        method: "GET",
        headers: { authorization: "Bearer api-key-123" },
        routeOptions: {
          schema: { operationId: "getAgents" },
        },
      } as FastifyRequest;

      const mockReply = {
        status: vi.fn().mockReturnThis(),
        send: vi.fn(),
      } as unknown as FastifyReply;

      await authnz.handle(mockRequest, mockReply);

      expect(mockAuth.api.verifyApiKey).toHaveBeenCalledWith({
        body: { key: "Bearer api-key-123" },
      });
      expect(mockReply.status).not.toHaveBeenCalled();
    });

    it("should check specific permissions for configured routes", async () => {
      mockAuth.api.getSession.mockResolvedValue({
        user: { id: "user1" },
        session: { activeOrganizationId: "org1" },
      });
      mockAuth.api.hasPermission.mockResolvedValue({
        success: true,
        error: null,
      });

      const mockRequest = {
        url: "/api/agents",
        method: "POST",
        headers: {},
        routeOptions: {
          schema: { operationId: "createAgent" },
        },
      } as FastifyRequest;

      const mockReply = {
        status: vi.fn().mockReturnThis(),
        send: vi.fn(),
      } as unknown as FastifyReply;

      await authnz.handle(mockRequest, mockReply);

      expect(mockAuth.api.hasPermission).toHaveBeenCalledWith({
        headers: expect.any(Headers),
        body: {
          permissions: { agent: ["create"] },
        },
      });
    });
  });

  describe("user info population", () => {
    it("should populate user and organizationId from session", async () => {
      const mockUser = { id: "user1", name: "Test User" };
      mockAuth.api.getSession.mockResolvedValue({
        user: { id: "user1" },
        session: { activeOrganizationId: "org1" },
      });
      mockAuth.api.hasPermission.mockResolvedValue({
        success: true,
        error: null,
      });

      // Mock UserModel
      const mockUserModel = {
        getUserById: vi.fn().mockResolvedValue(mockUser),
      };
      vi.doMock("@/models", () => ({
        UserModel: mockUserModel,
      }));

      const mockRequest = {
        url: "/api/agents",
        method: "GET",
        headers: {},
        routeOptions: {
          schema: { operationId: "getAgents" },
        },
      } as FastifyRequest;

      const mockReply = {
        status: vi.fn().mockReturnThis(),
        send: vi.fn(),
      } as unknown as FastifyReply;

      await authnz.handle(mockRequest, mockReply);

      expect(mockRequest.user).toEqual(mockUser);
      expect(mockRequest.organizationId).toBe("org1");
    });
  });

  describe("MCP proxy authentication", () => {
    it("should allow valid internal JWT for MCP proxy endpoints", async () => {
      const mockVerifyInternalJwt = vi
        .fn()
        .mockResolvedValue({ userId: "system" });
      vi.doMock("@/utils/internal-jwt", () => ({
        verifyInternalJwt: mockVerifyInternalJwt,
      }));

      const mockRequest = {
        url: "/mcp_proxy/server1",
        method: "POST",
        headers: { authorization: "Bearer internal-jwt-token" },
        routeOptions: {
          schema: { operationId: "mcpProxy" },
        },
      } as FastifyRequest;

      const mockReply = {
        status: vi.fn().mockReturnThis(),
        send: vi.fn(),
      } as unknown as FastifyReply;

      await authnz.handle(mockRequest, mockReply);

      expect(mockVerifyInternalJwt).toHaveBeenCalledWith("internal-jwt-token");
      expect(mockReply.status).not.toHaveBeenCalled();
    });

    it("should reject invalid internal JWT for MCP proxy endpoints", async () => {
      const mockVerifyInternalJwt = vi.fn().mockResolvedValue(null);
      vi.doMock("@/utils/internal-jwt", () => ({
        verifyInternalJwt: mockVerifyInternalJwt,
      }));

      const mockRequest = {
        url: "/mcp_proxy/server1",
        method: "POST",
        headers: { authorization: "Bearer invalid-jwt" },
        routeOptions: {
          schema: { operationId: "mcpProxy" },
        },
      } as FastifyRequest;

      const mockReply = {
        status: vi.fn().mockReturnThis(),
        send: vi.fn(),
      } as unknown as FastifyReply;

      await authnz.handle(mockRequest, mockReply);

      expect(mockReply.status).toHaveBeenCalledWith(401);
    });
  });

  describe("edge cases", () => {
    it("should handle missing routeOptions gracefully", async () => {
      mockAuth.api.getSession.mockResolvedValue({
        user: { id: "user1" },
        session: { activeOrganizationId: "org1" },
      });

      const mockRequest = {
        url: "/api/agents",
        method: "GET",
        headers: {},
        // Missing routeOptions
      } as FastifyRequest;

      const mockReply = {
        status: vi.fn().mockReturnThis(),
        send: vi.fn(),
      } as unknown as FastifyReply;

      await authnz.handle(mockRequest, mockReply);

      expect(mockReply.status).toHaveBeenCalledWith(403);
    });

    it("should handle auth service errors gracefully", async () => {
      mockAuth.api.getSession.mockRejectedValue(new Error("Auth service down"));
      mockAuth.api.verifyApiKey.mockRejectedValue(
        new Error("API key service down"),
      );

      const mockRequest = {
        url: "/api/agents",
        method: "GET",
        headers: { authorization: "Bearer some-key" },
        routeOptions: {
          schema: { operationId: "getAgents" },
        },
      } as FastifyRequest;

      const mockReply = {
        status: vi.fn().mockReturnThis(),
        send: vi.fn(),
      } as unknown as FastifyReply;

      await authnz.handle(mockRequest, mockReply);

      expect(mockReply.status).toHaveBeenCalledWith(401);
    });

    it("should handle user population errors gracefully", async () => {
      mockAuth.api.getSession.mockResolvedValue({
        user: { id: "user1" },
        session: { activeOrganizationId: "org1" },
      });
      mockAuth.api.hasPermission.mockResolvedValue({
        success: true,
        error: null,
      });

      // Mock UserModel to throw error
      const mockUserModel = {
        getUserById: vi.fn().mockRejectedValue(new Error("DB error")),
      };
      vi.doMock("@/models", () => ({
        UserModel: mockUserModel,
      }));

      const mockRequest = {
        url: "/api/agents",
        method: "GET",
        headers: {},
        routeOptions: {
          schema: { operationId: "getAgents" },
        },
      } as FastifyRequest;

      const mockReply = {
        status: vi.fn().mockReturnThis(),
        send: vi.fn(),
      } as unknown as FastifyReply;

      await authnz.handle(mockRequest, mockReply);

      // Should still succeed even if user population fails
      expect(mockReply.status).not.toHaveBeenCalled();
    });
  });

  describe("plugin registration", () => {
    it("should register decorators and hooks", () => {
      const mockApp = {
        decorateRequest: vi.fn(),
        addHook: vi.fn(),
      } as unknown as FastifyInstance;

      authPlugin(mockApp);

      expect(mockApp.decorateRequest).toHaveBeenCalledWith("user");
      expect(mockApp.decorateRequest).toHaveBeenCalledWith("organizationId");
      expect(mockApp.addHook).toHaveBeenCalledWith(
        "preHandler",
        expect.any(Function),
      );
    });
  });
});
