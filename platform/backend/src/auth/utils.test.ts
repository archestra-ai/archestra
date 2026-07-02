import type { IncomingHttpHeaders } from "node:http";
import type { Permissions } from "@archestra/shared";
import { vi } from "vitest";

// better-auth is the real external auth boundary — mock it, not the DB.
vi.mock("./better-auth", () => ({
  auth: {
    api: {
      hasPermission: vi.fn(),
      verifyApiKey: vi.fn(),
    },
  },
}));

import {
  beforeEach,
  describe,
  expect,
  type MockedFunction,
  test,
} from "@/test";
import { auth as betterAuth } from "./better-auth";
import { hasPermission } from "./utils";

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
      const permissions: Permissions = { agent: ["read"] };
      const headers: IncomingHttpHeaders = { cookie: "session-cookie" };

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
      const headers: IncomingHttpHeaders = { cookie: "session-cookie" };

      mockBetterAuth.api.hasPermission.mockResolvedValue({
        success: false,
        error: null,
      });

      const result = await hasPermission(permissions, headers);

      expect(result).toEqual({ success: false, error: null });
      expect(mockBetterAuth.api.hasPermission).toHaveBeenCalledWith({
        headers: expect.any(Headers),
        body: { permissions },
      });
    });
  });

  describe("API key authentication", () => {
    test("should allow valid API key when session check fails", async ({
      makeOrganization,
      makeUser,
      makeMember,
      makeCustomRole,
    }) => {
      const org = await makeOrganization();
      const user = await makeUser();
      const role = await makeCustomRole(org.id, {
        permission: { agent: ["read"] },
      });
      await makeMember(user.id, org.id, { role: role.role });

      const permissions: Permissions = { agent: ["read"] };
      const headers: IncomingHttpHeaders = {
        authorization: "Bearer api-key-123",
      };

      // No active session/organization → session check throws, API key fallback runs.
      mockBetterAuth.api.hasPermission.mockRejectedValue(
        new Error("No active organization"),
      );
      mockBetterAuth.api.verifyApiKey.mockResolvedValue({
        valid: true,
        error: null,
        key: makeApiKey({ referenceId: user.id, metadata: null }),
      });

      const result = await hasPermission(permissions, headers);

      expect(result).toEqual({ success: true, error: null });
      expect(mockBetterAuth.api.verifyApiKey).toHaveBeenCalledWith({
        body: { key: "Bearer api-key-123" },
      });
    });

    test("should reject when API key owner lacks required permissions", async ({
      makeOrganization,
      makeUser,
      makeMember,
      makeCustomRole,
    }) => {
      const org = await makeOrganization();
      const user = await makeUser();
      const role = await makeCustomRole(org.id, {
        permission: { agent: ["read"] },
      });
      await makeMember(user.id, org.id, { role: role.role });

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
        key: makeApiKey({ referenceId: user.id, metadata: null }),
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

      mockBetterAuth.api.hasPermission.mockRejectedValue(
        new Error("No active organization"),
      );
      mockBetterAuth.api.verifyApiKey.mockResolvedValue({
        valid: false,
        error: null,
        key: null,
      });

      const result = await hasPermission(permissions, headers);

      expect(result).toEqual({
        success: false,
        error: expect.objectContaining({ message: "Invalid API key" }),
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
        key: makeApiKey({ referenceId: undefined as unknown as string }),
      });

      const result = await hasPermission(permissions, headers);

      expect(result).toEqual({
        success: false,
        error: expect.objectContaining({ message: "Invalid API key" }),
      });
    });

    test("should handle API key verification errors", async () => {
      const permissions: Permissions = { agent: ["read"] };
      const headers: IncomingHttpHeaders = {
        authorization: "Bearer some-key",
      };

      mockBetterAuth.api.hasPermission.mockRejectedValue(
        new Error("No active organization"),
      );
      mockBetterAuth.api.verifyApiKey.mockRejectedValue(
        new Error("API key service error"),
      );

      const result = await hasPermission(permissions, headers);

      expect(result).toEqual({
        success: false,
        error: expect.objectContaining({ message: "Invalid API key" }),
      });
    });

    test("should return error when no authorization header provided and session check fails", async () => {
      const permissions: Permissions = { agent: ["read"] };
      const headers: IncomingHttpHeaders = {};

      mockBetterAuth.api.hasPermission.mockRejectedValue(
        new Error("No active organization"),
      );

      const result = await hasPermission(permissions, headers);

      expect(result).toEqual({
        success: false,
        error: expect.objectContaining({ message: "No API key provided" }),
      });
      expect(mockBetterAuth.api.verifyApiKey).not.toHaveBeenCalled();
    });
  });

  describe("edge cases", () => {
    test("should handle empty permissions object", async () => {
      const permissions: Permissions = {};
      const headers: IncomingHttpHeaders = { cookie: "session-cookie" };

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

    test("should handle complex permissions object", async ({
      makeOrganization,
      makeUser,
      makeMember,
      makeCustomRole,
    }) => {
      const permissions: Permissions = {
        agent: ["read", "create", "update", "delete"],
        mcpServerInstallation: ["admin"],
        team: ["read"],
      };
      const org = await makeOrganization();
      const user = await makeUser();
      const role = await makeCustomRole(org.id, { permission: permissions });
      await makeMember(user.id, org.id, { role: role.role });

      const headers: IncomingHttpHeaders = {
        authorization: "Bearer api-key-complex",
      };

      mockBetterAuth.api.hasPermission.mockRejectedValue(
        new Error("No session"),
      );
      mockBetterAuth.api.verifyApiKey.mockResolvedValue({
        valid: true,
        error: null,
        key: makeApiKey({ referenceId: user.id, metadata: null }),
      });

      const result = await hasPermission(permissions, headers);

      expect(result).toEqual({ success: true, error: null });
      expect(mockBetterAuth.api.verifyApiKey).toHaveBeenCalledWith({
        body: { key: "Bearer api-key-complex" },
      });
    });

    test("should pass through different authorization header formats", async ({
      makeOrganization,
      makeUser,
      makeMember,
      makeCustomRole,
    }) => {
      const org = await makeOrganization();
      const user = await makeUser();
      const role = await makeCustomRole(org.id, {
        permission: { agent: ["read"] },
      });
      await makeMember(user.id, org.id, { role: role.role });

      const permissions: Permissions = { agent: ["read"] };
      const testCases = [
        "Bearer token123",
        "token456",
        "Basic dXNlcjpwYXNz", // Different auth scheme
      ];

      for (const authHeader of testCases) {
        const headers: IncomingHttpHeaders = { authorization: authHeader };

        mockBetterAuth.api.hasPermission.mockRejectedValue(
          new Error("No session"),
        );
        mockBetterAuth.api.verifyApiKey.mockResolvedValue({
          valid: true,
          error: null,
          key: makeApiKey({ referenceId: user.id, metadata: null }),
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
