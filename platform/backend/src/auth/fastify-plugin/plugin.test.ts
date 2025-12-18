import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { vi } from "vitest";
import {
  beforeEach,
  describe,
  expect,
  type MockedFunction,
  test,
} from "@/test";

// Mock modules with factory functions to avoid hoisting issues
vi.mock("@/auth", () => ({
  betterAuth: {
    api: {
      getSession: vi.fn(),
      verifyApiKey: vi.fn(),
    },
  },
  hasPermission: vi.fn(),
}));

vi.mock("@/auth/utils", () => ({
  hasPermission: vi.fn(),
}));

vi.mock("@/models", () => ({
  UserModel: {
    getById: vi.fn(),
  },
}));

vi.mock("@shared/access-control", () => ({
  requiredEndpointPermissionsMap: {
    createAgent: { profile: ["create"] },
    getAgents: { profile: ["read"] },
  },
  allAvailableActions: {},
  editorPermissions: {},
  memberPermissions: {},
}));

import { betterAuth, hasPermission } from "@/auth";
import { UserModel } from "@/models";

// Type the mocked functions
const mockBetterAuth = betterAuth as unknown as {
  api: {
    getSession: MockedFunction<typeof betterAuth.api.getSession>;
    verifyApiKey: MockedFunction<typeof betterAuth.api.verifyApiKey>;
  };
};

const mockHasPermission = hasPermission as MockedFunction<typeof hasPermission>;

const mockUserModel = UserModel as unknown as {
  getById: MockedFunction<typeof UserModel.getById>;
};

import { Authnz } from "./middleware";
import { authPlugin } from "./plugin";

type Session = Awaited<ReturnType<typeof betterAuth.api.getSession>>;
type User = Awaited<ReturnType<typeof UserModel.getById>>;
type ApiKey = Awaited<ReturnType<typeof betterAuth.api.verifyApiKey>>["key"];

describe("authPlugin integration", () => {
  const authnz = new Authnz();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("authentication", () => {
    test("should allow authenticated session users", async () => {
      mockBetterAuth.api.getSession.mockResolvedValue({
        user: { id: "user1" },
        session: { activeOrganizationId: "org1" },
      } as Session);
      mockHasPermission.mockResolvedValue({
        success: true,
        error: null,
      });
      mockUserModel.getById.mockResolvedValue({
        id: "user1",
        name: "Test User",
        organizationId: "org1",
      } as User);

      const mockRequest = {
        url: "/api/agents",
        method: "GET",
        headers: {},
        routeOptions: {
          schema: { operationId: "getAgents" },
        },
      } as unknown as FastifyRequest;

      const mockReply = {
        status: vi.fn().mockReturnThis(),
        send: vi.fn(),
      } as unknown as FastifyReply;

      await authnz.handle(mockRequest, mockReply);

      expect(mockReply.status).not.toHaveBeenCalled();
      expect(mockReply.send).not.toHaveBeenCalled();
    });

    test("should allow valid API key authentication", async () => {
      mockBetterAuth.api.getSession.mockRejectedValue(new Error("No session"));
      mockBetterAuth.api.verifyApiKey.mockResolvedValue({
        valid: true,
        error: null,
        key: {
          userId: "user1",
          enabled: true,
          id: "api-key-123",
          createdAt: new Date(),
          updatedAt: new Date(),
        } as ApiKey,
      });
      mockHasPermission.mockResolvedValue({
        success: true,
        error: null,
      });
      mockUserModel.getById.mockResolvedValue({
        id: "user1",
        name: "Test User",
        organizationId: "org1",
      } as User);

      const mockRequest = {
        url: "/api/agents",
        method: "GET",
        headers: { authorization: "Bearer api-key-123" },
        routeOptions: {
          schema: { operationId: "getAgents" },
        },
      } as unknown as FastifyRequest;

      const mockReply = {
        status: vi.fn().mockReturnThis(),
        send: vi.fn(),
      } as unknown as FastifyReply;

      await authnz.handle(mockRequest, mockReply);

      expect(mockBetterAuth.api.verifyApiKey).toHaveBeenCalledWith({
        body: { key: "Bearer api-key-123" },
      });
      expect(mockReply.status).not.toHaveBeenCalled();
    });

    test("should return 401 for invalid session", async () => {
      mockBetterAuth.api.getSession.mockResolvedValue(null);

      const mockRequest = {
        url: "/api/agents",
        method: "GET",
        headers: {},
        routeOptions: {
          schema: { operationId: "getAgents" },
        },
      } as unknown as FastifyRequest;

      const mockReply = {
        status: vi.fn().mockReturnThis(),
        send: vi.fn(),
      } as unknown as FastifyReply;

      await expect(authnz.handle(mockRequest, mockReply)).rejects.toThrow(
        "Unauthenticated",
      );
    });

    test("should return 401 for invalid API key", async () => {
      mockBetterAuth.api.getSession.mockRejectedValue(new Error("No session"));
      mockBetterAuth.api.verifyApiKey.mockResolvedValue({
        valid: false,
        error: null,
        key: null,
      });

      const mockRequest = {
        url: "/api/agents",
        method: "GET",
        headers: { authorization: "Bearer invalid-key" },
        routeOptions: {
          schema: { operationId: "getAgents" },
        },
      } as unknown as FastifyRequest;

      const mockReply = {
        status: vi.fn().mockReturnThis(),
        send: vi.fn(),
      } as unknown as FastifyReply;

      await expect(authnz.handle(mockRequest, mockReply)).rejects.toThrow(
        "Unauthenticated",
      );
    });
  });

  describe("authorization", () => {
    test("should return 403 for insufficient permissions", async () => {
      mockBetterAuth.api.getSession.mockResolvedValue({
        user: { id: "user1" },
        session: { activeOrganizationId: "org1" },
      } as Session);
      mockUserModel.getById.mockResolvedValue({
        id: "user1",
        name: "Test User",
        organizationId: "org1",
      } as User);
      mockHasPermission.mockResolvedValue({
        success: false,
        error: null,
      });

      const mockRequest = {
        url: "/api/agents",
        method: "POST",
        headers: {},
        routeOptions: {
          schema: { operationId: "createAgent" },
        },
      } as unknown as FastifyRequest;

      const mockReply = {
        status: vi.fn().mockReturnThis(),
        send: vi.fn(),
      } as unknown as FastifyReply;

      await expect(authnz.handle(mockRequest, mockReply)).rejects.toThrow(
        "Forbidden",
      );
    });

    test("should return 403 for routes without operationId", async () => {
      mockBetterAuth.api.getSession.mockResolvedValue({
        user: { id: "user1" },
        session: { activeOrganizationId: "org1" },
      } as Session);
      mockUserModel.getById.mockResolvedValue({
        id: "user1",
        name: "Test User",
        organizationId: "org1",
      } as User);

      const mockRequest = {
        url: "/api/unknown",
        method: "GET",
        headers: {},
        routeOptions: {
          schema: {}, // No operationId
        },
      } as unknown as FastifyRequest;

      const mockReply = {
        status: vi.fn().mockReturnThis(),
        send: vi.fn(),
      } as unknown as FastifyReply;

      await expect(authnz.handle(mockRequest, mockReply)).rejects.toThrow(
        "Forbidden",
      );
    });

    test("should check specific permissions for configured routes", async () => {
      mockBetterAuth.api.getSession.mockResolvedValue({
        user: { id: "user1" },
        session: { activeOrganizationId: "org1" },
      } as Session);
      mockHasPermission.mockResolvedValue({
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
      } as unknown as FastifyRequest;

      const mockReply = {
        status: vi.fn().mockReturnThis(),
        send: vi.fn(),
      } as unknown as FastifyReply;

      await authnz.handle(mockRequest, mockReply);

      expect(mockHasPermission).toHaveBeenCalledWith(
        { profile: ["create"] },
        expect.objectContaining({}),
      );
    });
  });

  describe("user info population", () => {
    test("should populate user and organizationId from session", async () => {
      mockBetterAuth.api.getSession.mockResolvedValue({
        user: { id: "user1" },
        session: { activeOrganizationId: "org1" },
      } as Session);
      mockHasPermission.mockResolvedValue({
        success: true,
        error: null,
      });
      mockUserModel.getById.mockResolvedValue({
        id: "user1",
        name: "Test User",
        organizationId: "org1",
      } as User);

      const mockRequest = {
        url: "/api/agents",
        method: "GET",
        headers: {},
        routeOptions: {
          schema: { operationId: "getAgents" },
        },
      } as unknown as FastifyRequest;

      const mockReply = {
        status: vi.fn().mockReturnThis(),
        send: vi.fn(),
      } as unknown as FastifyReply;

      await authnz.handle(mockRequest, mockReply);

      expect(mockRequest.user).toEqual({ id: "user1", name: "Test User" });
      expect(mockRequest.organizationId).toBe("org1");
    });

    test("should populate organizationId from UserModel when not in session", async () => {
      const mockUser = {
        id: "user1",
        name: "Test User",
        organizationId: "org2",
      } as User;
      mockBetterAuth.api.getSession.mockResolvedValue({
        user: { id: "user1" },
        session: {}, // No activeOrganizationId
      } as Session);
      mockHasPermission.mockResolvedValue({
        success: true,
        error: null,
      });
      mockUserModel.getById.mockResolvedValue(mockUser);

      const mockRequest = {
        url: "/api/agents",
        method: "GET",
        headers: {},
        routeOptions: {
          schema: { operationId: "getAgents" },
        },
      } as unknown as FastifyRequest;

      const mockReply = {
        status: vi.fn().mockReturnThis(),
        send: vi.fn(),
      } as unknown as FastifyReply;

      await authnz.handle(mockRequest, mockReply);

      expect(mockUserModel.getById).toHaveBeenCalledWith("user1");
      expect(mockRequest.user).toEqual({ id: "user1", name: "Test User" });
      expect(mockRequest.organizationId).toBe("org2");
    });
  });

  describe("edge cases", () => {
    test("should handle auth service errors gracefully", async () => {
      mockBetterAuth.api.getSession.mockRejectedValue(
        new Error("Auth service down"),
      );
      mockBetterAuth.api.verifyApiKey.mockRejectedValue(
        new Error("API key service down"),
      );

      const mockRequest = {
        url: "/api/agents",
        method: "GET",
        headers: { authorization: "Bearer some-key" },
        routeOptions: {
          schema: { operationId: "getAgents" },
        },
      } as unknown as FastifyRequest;

      const mockReply = {
        status: vi.fn().mockReturnThis(),
        send: vi.fn(),
      } as unknown as FastifyReply;

      await expect(authnz.handle(mockRequest, mockReply)).rejects.toThrow(
        "Unauthenticated",
      );
    });

    test("should handle user population errors gracefully", async () => {
      mockBetterAuth.api.getSession.mockResolvedValue({
        user: { id: "user1" },
        session: { activeOrganizationId: "org1" },
      } as Session);
      mockHasPermission.mockResolvedValue({
        success: true,
        error: null,
      });
      mockUserModel.getById.mockRejectedValue(new Error("DB error"));

      const mockRequest = {
        url: "/api/agents",
        method: "GET",
        headers: {},
        routeOptions: {
          schema: { operationId: "getAgents" },
        },
      } as unknown as FastifyRequest;

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
    test("should register decorators and hooks", () => {
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
