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
      hasPermission: vi.fn(),
      verifyApiKey: vi.fn(),
    },
  },
}));

import { auth as betterAuth } from "./better-auth";

// Type the mocked functions
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
  });

  describe("session-based authentication", () => {
    test("should return success when user has required permissions", async () => {
      const permissions: Permissions = { profile: ["read"] };
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
      const permissions: Permissions = { profile: ["admin"] };
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
      const permissions: Permissions = { profile: ["read"] };
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

    test("should handle API key verification errors", async () => {
      const permissions: Permissions = { profile: ["read"] };
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
      const permissions: Permissions = { profile: ["read"] };
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
        profile: ["read", "create", "update", "delete"],
        mcpServer: ["admin"],
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

        mockBetterAuth.api.hasPermission.mockRejectedValue(
          new Error("No session"),
        );

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
