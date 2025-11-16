import type { IncomingHttpHeaders } from "node:http";
import type { Permissions } from "@shared";
import { vi } from "vitest";
import {
  beforeEach,
  describe,
  expect,
  type MockedFunction,
  test,
} from "@/test";
import { hasPermission } from "./utils";

// Mock the better-auth module
vi.mock("./better-auth", () => ({
  auth: {
    api: {
      getSession: vi.fn(),
      verifyApiKey: vi.fn(),
    },
  },
}));

// Mock the model modules
vi.mock("@/models", () => ({
  MemberModel: {
    getByUserAndOrganization: vi.fn(),
  },
  OrganizationRoleModel: {
    getAllCustomRoles: vi.fn(),
  },
}));

import { MemberModel, OrganizationRoleModel } from "@/models";
import { auth as betterAuth } from "./better-auth";

// Type the mocked functions
const mockBetterAuth = betterAuth as unknown as {
  api: {
    getSession: MockedFunction<typeof betterAuth.api.getSession>;
    verifyApiKey: MockedFunction<typeof betterAuth.api.verifyApiKey>;
  };
};

const mockMemberModel = MemberModel as unknown as {
  getByUserAndOrganization: MockedFunction<
    typeof MemberModel.getByUserAndOrganization
  >;
};

const mockOrganizationRoleModel = OrganizationRoleModel as unknown as {
  getAllCustomRoles: MockedFunction<
    typeof OrganizationRoleModel.getAllCustomRoles
  >;
};

type ApiKey = Awaited<ReturnType<typeof betterAuth.api.verifyApiKey>>["key"];

describe("hasPermission", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("session-based authentication", () => {
    test("should return success when admin user has required permissions", async () => {
      const permissions: Permissions = { profile: ["read"] };
      const headers: IncomingHttpHeaders = {
        cookie: "session-cookie",
      };

      // Mock successful session
      mockBetterAuth.api.getSession.mockResolvedValue({
        user: {
          id: "user-1",
          email: "admin@test.com",
          name: "Admin User",
          emailVerified: true,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        session: {
          id: "session-1",
          userId: "user-1",
          activeOrganizationId: "org-1",
          token: "session-token",
          expiresAt: new Date(Date.now() + 86400000),
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        // biome-ignore lint/suspicious/noExplicitAny: Required for mocking better-auth session types
      } as any);

      // Mock member record with admin role
      mockMemberModel.getByUserAndOrganization.mockResolvedValue({
        id: "member-1",
        userId: "user-1",
        organizationId: "org-1",
        role: "admin",
        createdAt: new Date(),
      });

      // Mock no custom roles
      mockOrganizationRoleModel.getAllCustomRoles.mockResolvedValue([]);

      const result = await hasPermission(permissions, headers);

      expect(result).toEqual({ success: true, error: null });
      expect(mockBetterAuth.api.getSession).toHaveBeenCalledWith({
        headers: expect.any(Headers),
      });
      expect(mockMemberModel.getByUserAndOrganization).toHaveBeenCalledWith(
        "user-1",
        "org-1",
      );
      expect(mockOrganizationRoleModel.getAllCustomRoles).toHaveBeenCalledWith(
        "org-1",
      );
    });

    test("should return failure when member user lacks required permissions", async () => {
      const permissions: Permissions = { profile: ["admin"] };
      const headers: IncomingHttpHeaders = {
        cookie: "session-cookie",
      };

      // Mock successful session
      mockBetterAuth.api.getSession.mockResolvedValue({
        user: {
          id: "user-2",
          email: "member@test.com",
          name: "Member User",
          emailVerified: true,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        session: {
          id: "session-2",
          userId: "user-2",
          activeOrganizationId: "org-1",
          token: "session-token-2",
          expiresAt: new Date(Date.now() + 86400000),
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        // biome-ignore lint/suspicious/noExplicitAny: Required for mocking better-auth session types
      } as any);

      // Mock member record with member role (lacks admin permissions)
      mockMemberModel.getByUserAndOrganization.mockResolvedValue({
        id: "member-2",
        userId: "user-2",
        organizationId: "org-1",
        role: "member",
        createdAt: new Date(),
      });

      // Mock no custom roles
      mockOrganizationRoleModel.getAllCustomRoles.mockResolvedValue([]);

      const result = await hasPermission(permissions, headers);

      expect(result).toEqual({
        success: false,
        error: null,
      });
      expect(mockMemberModel.getByUserAndOrganization).toHaveBeenCalledWith(
        "user-2",
        "org-1",
      );
    });
  });

  describe("API key authentication", () => {
    test("should allow valid API key when session check fails", async () => {
      const permissions: Permissions = { profile: ["read"] };
      const headers: IncomingHttpHeaders = {
        authorization: "Bearer api-key-123",
      };

      // Mock getSession to return undefined (triggers API key fallback)
      // biome-ignore lint/suspicious/noExplicitAny: Required for mocking undefined session
      mockBetterAuth.api.getSession.mockResolvedValue(undefined as any);

      // Mock API key verification to succeed
      mockBetterAuth.api.verifyApiKey.mockResolvedValue({
        valid: true,
        error: null,
        key: { userId: "user1" } as ApiKey,
      });

      const result = await hasPermission(permissions, headers);

      expect(result).toEqual({ success: true, error: null });
      expect(mockBetterAuth.api.verifyApiKey).toHaveBeenCalledWith({
        body: { key: "Bearer api-key-123" },
      });
    });

    test("should reject invalid API key when session check fails", async () => {
      const permissions: Permissions = { profile: ["read"] };
      const headers: IncomingHttpHeaders = {
        authorization: "Bearer invalid-key",
      };

      // Mock getSession to return undefined (triggers API key fallback)
      // biome-ignore lint/suspicious/noExplicitAny: Required for mocking undefined session
      mockBetterAuth.api.getSession.mockResolvedValue(undefined as any);

      // Mock API key verification to fail
      mockBetterAuth.api.verifyApiKey.mockResolvedValue({
        valid: false,
        error: null,
        key: null,
      });

      const result = await hasPermission(permissions, headers);

      expect(result).toEqual({
        success: false,
        error: expect.objectContaining({
          message: "No API key provided",
        }),
      });
    });

    test("should handle API key verification errors", async () => {
      const permissions: Permissions = { profile: ["read"] };
      const headers: IncomingHttpHeaders = {
        authorization: "Bearer some-key",
      };

      // Mock getSession to return undefined (triggers API key fallback)
      // biome-ignore lint/suspicious/noExplicitAny: Required for mocking undefined session
      mockBetterAuth.api.getSession.mockResolvedValue(undefined as any);

      // Mock API key verification to throw
      mockBetterAuth.api.verifyApiKey.mockRejectedValue(
        new Error("API key service error"),
      );

      const result = await hasPermission(permissions, headers);

      expect(result).toEqual({
        success: false,
        error: expect.objectContaining({
          message: "Invalid API key",
        }),
      });
    });

    test("should return error when no authorization header provided and session check fails", async () => {
      const permissions: Permissions = { profile: ["read"] };
      const headers: IncomingHttpHeaders = {};

      // Mock getSession to return undefined (triggers API key fallback)
      // biome-ignore lint/suspicious/noExplicitAny: Required for mocking undefined session
      mockBetterAuth.api.getSession.mockResolvedValue(undefined as any);

      const result = await hasPermission(permissions, headers);

      expect(result).toEqual({
        success: false,
        error: expect.objectContaining({
          message: "No API key provided",
        }),
      });
      expect(mockBetterAuth.api.verifyApiKey).not.toHaveBeenCalled();
    });
  });

  describe("edge cases", () => {
    test("should handle empty permissions object", async () => {
      const permissions: Permissions = {};
      const headers: IncomingHttpHeaders = {
        cookie: "session-cookie",
      };

      // Mock successful session
      mockBetterAuth.api.getSession.mockResolvedValue({
        user: {
          id: "user-1",
          email: "admin@test.com",
          name: "Admin User",
          emailVerified: true,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        session: {
          id: "session-1",
          userId: "user-1",
          activeOrganizationId: "org-1",
          token: "session-token",
          expiresAt: new Date(Date.now() + 86400000),
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        // biome-ignore lint/suspicious/noExplicitAny: Required for mocking better-auth session types
      } as any);

      // Mock member record with admin role
      mockMemberModel.getByUserAndOrganization.mockResolvedValue({
        id: "member-1",
        userId: "user-1",
        organizationId: "org-1",
        role: "admin",
        createdAt: new Date(),
      });

      // Mock no custom roles
      mockOrganizationRoleModel.getAllCustomRoles.mockResolvedValue([]);

      const result = await hasPermission(permissions, headers);

      expect(result).toEqual({ success: true, error: null });
    });

    test("should handle complex permissions object with API key", async () => {
      const permissions: Permissions = {
        profile: ["read", "create", "update", "delete"],
        mcpServer: ["admin"],
        team: ["read"],
      };
      const headers: IncomingHttpHeaders = {
        authorization: "Bearer api-key-complex",
      };

      // Mock getSession to return undefined (triggers API key fallback)
      // biome-ignore lint/suspicious/noExplicitAny: Required for mocking undefined session
      mockBetterAuth.api.getSession.mockResolvedValue(undefined as any);

      mockBetterAuth.api.verifyApiKey.mockResolvedValue({
        valid: true,
        error: null,
        key: { userId: "user1" } as ApiKey,
      });

      const result = await hasPermission(permissions, headers);

      expect(result).toEqual({ success: true, error: null });
      expect(mockBetterAuth.api.verifyApiKey).toHaveBeenCalledWith({
        body: { key: "Bearer api-key-complex" },
      });
    });

    test("should pass through different authorization header formats", async () => {
      const permissions: Permissions = { profile: ["read"] };

      // Test different header formats
      const testCases = [
        "Bearer token123",
        "token456",
        "Basic dXNlcjpwYXNz", // Different auth scheme
      ];

      for (const authHeader of testCases) {
        const headers: IncomingHttpHeaders = {
          authorization: authHeader,
        };

        // Mock getSession to return undefined (triggers API key fallback)
        // biome-ignore lint/suspicious/noExplicitAny: Required for mocking undefined session
        mockBetterAuth.api.getSession.mockResolvedValue(undefined as any);

        mockBetterAuth.api.verifyApiKey.mockResolvedValue({
          valid: true,
          error: null,
          key: { userId: "user1" } as ApiKey,
        });

        const result = await hasPermission(permissions, headers);

        expect(result).toEqual({ success: true, error: null });
        expect(mockBetterAuth.api.verifyApiKey).toHaveBeenCalledWith({
          body: { key: authHeader },
        });

        vi.clearAllMocks();
      }
    });
  });
});
