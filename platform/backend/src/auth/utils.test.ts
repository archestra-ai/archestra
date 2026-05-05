import type { IncomingHttpHeaders } from "node:http";
import type { Permissions } from "@shared";
import { vi } from "vitest";
import { UserModel } from "@/models";
import {
  beforeEach,
  describe,
  expect,
  type MockedFunction,
  test,
} from "@/test";
import { hasPermission } from "./utils";

vi.mock("@/models", () => ({
  UserModel: {
    getById: vi.fn(),
    getUserPermissions: vi.fn(),
  },
}));

// Mock the better-auth module
vi.mock("./better-auth", () => ({
  auth: {
    api: {
      hasPermission: vi.fn(),
      verifyApiKey: vi.fn(),
    },
  },
}));

import { auth as betterAuth } from "./better-auth";

// Type the mocked functions
const mockUserModel = UserModel as unknown as {
  getById: MockedFunction<typeof UserModel.getById>;
  getUserPermissions: MockedFunction<typeof UserModel.getUserPermissions>;
};

const mockBetterAuth = betterAuth as unknown as {
  api: {
    hasPermission: MockedFunction<typeof betterAuth.api.hasPermission>;
    verifyApiKey: MockedFunction<typeof betterAuth.api.verifyApiKey>;
  };
};

type ApiKey = Awaited<ReturnType<typeof betterAuth.api.verifyApiKey>>["key"];

describe("hasPermission", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUserModel.getById.mockResolvedValue(makeUserWithOrganization());
    mockUserModel.getUserPermissions.mockResolvedValue({
      agent: ["read", "create", "update", "delete", "admin"],
      mcpServerInstallation: ["admin"],
      team: ["read"],
    });
  });

  describe("session-based authentication", () => {
    test("should return success when user has required permissions", async () => {
      const permissions: Permissions = { agent: ["read"] };
      const headers: IncomingHttpHeaders = {
        cookie: "session-cookie",
      };

      mockBetterAuth.api.hasPermission.mockResolvedValue({
        success: true,
        error: null,
      });

      const result = await hasPermission(permissions, headers);

      expect(result).toEqual({ success: true, error: null });
      expect(mockBetterAuth.api.hasPermission).toHaveBeenCalledWith({
        headers: expect.any(Headers),
        body: { permissions },
      });
    });

    test("should return failure when user lacks required permissions", async () => {
      const permissions: Permissions = { agent: ["admin"] };
      const headers: IncomingHttpHeaders = {
        cookie: "session-cookie",
      };

      mockBetterAuth.api.hasPermission.mockResolvedValue({
        success: false,
        error: null,
      });

      const result = await hasPermission(permissions, headers);

      expect(result).toEqual({
        success: false,
        error: null,
      });
      expect(mockBetterAuth.api.hasPermission).toHaveBeenCalledWith({
        headers: expect.any(Headers),
        body: { permissions },
      });
    });
  });

  describe("API key authentication", () => {
    test("should allow valid API key when session check fails", async () => {
      const permissions: Permissions = { agent: ["read"] };
      const headers: IncomingHttpHeaders = {
        authorization: "Bearer api-key-123",
      };

      // Mock hasPermission to throw (simulating no active session/organization)
      mockBetterAuth.api.hasPermission.mockRejectedValue(
        new Error("No active organization"),
      );

      // Mock API key verification to succeed
      mockBetterAuth.api.verifyApiKey.mockResolvedValue({
        valid: true,
        error: null,
        key: makeApiKey({
          referenceId: "user1",
          metadata: null,
        }),
      });

      const result = await hasPermission(permissions, headers);

      expect(result).toEqual({ success: true, error: null });
      expect(mockUserModel.getById).toHaveBeenCalledWith("user1");
      expect(mockUserModel.getUserPermissions).toHaveBeenCalledWith(
        "user1",
        "org-1",
      );
      expect(mockBetterAuth.api.verifyApiKey).toHaveBeenCalledWith({
        body: { key: "Bearer api-key-123" },
      });
    });

    test("should reject when API key owner lacks required permissions", async () => {
      const permissions: Permissions = { agent: ["admin"] };
      const headers: IncomingHttpHeaders = {
        authorization: "Bearer limited-user-key",
      };

      mockBetterAuth.api.hasPermission.mockRejectedValue(
        new Error("No session"),
      );
      mockBetterAuth.api.verifyApiKey.mockResolvedValue({
        valid: true,
        error: null,
        key: makeApiKey({
          referenceId: "user-limited",
          metadata: null,
        }),
      });
      mockUserModel.getById.mockResolvedValue(
        makeUserWithOrganization({
          id: "user-limited",
          email: "user-limited@test.com",
        }),
      );
      mockUserModel.getUserPermissions.mockResolvedValue({
        agent: ["read"],
      });

      const result = await hasPermission(permissions, headers);

      expect(result).toEqual({
        success: false,
        error: expect.objectContaining({ message: "Forbidden" }),
      });
    });

    test("should reject invalid API key when session check fails", async () => {
      const permissions: Permissions = { agent: ["read"] };
      const headers: IncomingHttpHeaders = {
        authorization: "Bearer invalid-key",
      };

      // Mock hasPermission to throw
      mockBetterAuth.api.hasPermission.mockRejectedValue(
        new Error("No active organization"),
      );

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

    test("should reject API key without an owner reference", async () => {
      const permissions: Permissions = { agent: ["read"] };
      const headers: IncomingHttpHeaders = {
        authorization: "Bearer ownerless-key",
      };

      mockBetterAuth.api.hasPermission.mockRejectedValue(
        new Error("No active organization"),
      );
      mockBetterAuth.api.verifyApiKey.mockResolvedValue({
        valid: true,
        error: null,
        key: makeApiKey({
          referenceId: undefined as unknown as string,
        }),
      });

      const result = await hasPermission(permissions, headers);

      expect(result).toEqual({
        success: false,
        error: expect.objectContaining({
          message: "No API key provided",
        }),
      });
      expect(mockUserModel.getById).not.toHaveBeenCalled();
      expect(mockUserModel.getUserPermissions).not.toHaveBeenCalled();
    });

    test("should handle API key verification errors", async () => {
      const permissions: Permissions = { agent: ["read"] };
      const headers: IncomingHttpHeaders = {
        authorization: "Bearer some-key",
      };

      // Mock hasPermission to throw
      mockBetterAuth.api.hasPermission.mockRejectedValue(
        new Error("No active organization"),
      );

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
      const permissions: Permissions = { agent: ["read"] };
      const headers: IncomingHttpHeaders = {};

      // Mock hasPermission to throw
      mockBetterAuth.api.hasPermission.mockRejectedValue(
        new Error("No active organization"),
      );

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

      mockBetterAuth.api.hasPermission.mockResolvedValue({
        success: true,
        error: null,
      });

      const result = await hasPermission(permissions, headers);

      expect(result).toEqual({ success: true, error: null });
      expect(mockBetterAuth.api.hasPermission).toHaveBeenCalledWith({
        headers: expect.any(Headers),
        body: { permissions: {} },
      });
    });

    test("should handle complex permissions object", async () => {
      const permissions: Permissions = {
        agent: ["read", "create", "update", "delete"],
        mcpServerInstallation: ["admin"],
        team: ["read"],
      };
      const headers: IncomingHttpHeaders = {
        authorization: "Bearer api-key-complex",
      };

      // Mock hasPermission to throw (API key fallback)
      mockBetterAuth.api.hasPermission.mockRejectedValue(
        new Error("No session"),
      );

      mockBetterAuth.api.verifyApiKey.mockResolvedValue({
        valid: true,
        error: null,
        key: makeApiKey({
          referenceId: "user1",
          metadata: null,
        }),
      });

      const result = await hasPermission(permissions, headers);

      expect(result).toEqual({ success: true, error: null });
      expect(mockUserModel.getUserPermissions).toHaveBeenCalledTimes(1);
      expect(mockBetterAuth.api.verifyApiKey).toHaveBeenCalledWith({
        body: { key: "Bearer api-key-complex" },
      });
    });

    test("should pass through different authorization header formats", async () => {
      const permissions: Permissions = { agent: ["read"] };

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

        mockBetterAuth.api.hasPermission.mockRejectedValue(
          new Error("No session"),
        );

        mockBetterAuth.api.verifyApiKey.mockResolvedValue({
          valid: true,
          error: null,
          key: makeApiKey({
            referenceId: "user1",
            metadata: null,
          }),
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

function makeApiKey(
  overrides: Partial<NonNullable<ApiKey>> = {},
): NonNullable<ApiKey> {
  return {
    id: "api-key-123",
    configId: "default",
    name: null,
    start: null,
    prefix: null,
    referenceId: "user1",
    refillInterval: null,
    refillAmount: null,
    lastRefillAt: null,
    enabled: true,
    rateLimitEnabled: false,
    rateLimitTimeWindow: null,
    rateLimitMax: null,
    requestCount: 0,
    remaining: null,
    lastRequest: null,
    expiresAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    metadata: null,
    permissions: null,
    ...overrides,
  };
}

function makeUserWithOrganization(
  overrides: Partial<Awaited<ReturnType<typeof UserModel.getById>>> = {},
): Awaited<ReturnType<typeof UserModel.getById>> {
  return {
    id: "user1",
    name: "Test User",
    email: "user1@test.com",
    emailVerified: true,
    image: null,
    role: null,
    banned: null,
    banReason: null,
    banExpires: null,
    twoFactorEnabled: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    organizationId: "org-1",
    ...overrides,
  };
}
