import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

// Mock dependencies at the top level
const mockAuth = {
  api: {
    getSession: vi.fn(),
    verifyApiKey: vi.fn(),
    hasPermission: vi.fn(),
  },
};

const mockUserModel = {
  getUserById: vi.fn(),
  getOrganizationId: vi.fn(),
};

const mockVerifyInternalJwt = vi.fn();

const mockConfig = {
  mcpGateway: {
    endpoint: "/v1/mcp",
  },
};

// Mock modules
vi.mock("@/auth", () => ({
  auth: mockAuth,
}));

vi.mock("@/models", () => ({
  UserModel: mockUserModel,
}));

vi.mock("@/utils/internal-jwt", () => ({
  verifyInternalJwt: mockVerifyInternalJwt,
}));

vi.mock("@/config", () => ({
  default: mockConfig,
}));

import { Authnz } from "./middleware";
import { authPlugin } from "./plugin";

describe("authPlugin integration", () => {
  const authnz = new Authnz();

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
      mockUserModel.getUserById.mockResolvedValue({
        id: "user1",
        name: "Test User",
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
      mockUserModel.getUserById.mockResolvedValue(mockUser);

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

    it("should populate organizationId from UserModel when not in session", async () => {
      const mockUser = { id: "user1", name: "Test User" };
      mockAuth.api.getSession.mockResolvedValue({
        user: { id: "user1" },
        session: {}, // No activeOrganizationId
      });
      mockAuth.api.hasPermission.mockResolvedValue({
        success: true,
        error: null,
      });
      mockUserModel.getUserById.mockResolvedValue(mockUser);
      mockUserModel.getOrganizationId.mockResolvedValue("org2");

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

      expect(mockUserModel.getOrganizationId).toHaveBeenCalledWith("user1");
      expect(mockRequest.organizationId).toBe("org2");
    });
  });

  describe("MCP proxy authentication", () => {
    it("should allow valid internal JWT for MCP proxy endpoints", async () => {
      mockVerifyInternalJwt.mockResolvedValue({ userId: "system" });

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
      mockVerifyInternalJwt.mockResolvedValue(null);

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
      mockUserModel.getUserById.mockRejectedValue(new Error("DB error"));

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
