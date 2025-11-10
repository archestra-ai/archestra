import type { Permissions } from "@shared";
import { describe, expect, it, vi } from "vitest";
import { hasPermission } from "./auth.utils";
import { authClient } from "./clients/auth/auth-client";

// Mock the auth client
vi.mock("./clients/auth/auth-client", () => ({
  authClient: {
    organization: {
      hasPermission: vi.fn(),
    },
  },
}));

type HasPermissionResponse = Awaited<
  ReturnType<typeof authClient.organization.hasPermission>
>;

describe("hasPermission", () => {
  it("should return true when user has permission", async () => {
    const mockPermissions: Permissions = { organization: ["read"] };

    vi.mocked(authClient.organization.hasPermission).mockResolvedValue({
      data: { success: true },
    } as HasPermissionResponse);

    const result = await hasPermission(mockPermissions);

    expect(result).toBe(true);
    expect(authClient.organization.hasPermission).toHaveBeenCalledWith({
      permissions: mockPermissions,
    });
  });

  it("should return false when user does not have permission", async () => {
    const mockPermissions: Permissions = { organization: ["create"] };

    vi.mocked(authClient.organization.hasPermission).mockResolvedValue({
      data: { success: false },
    } as HasPermissionResponse);

    const result = await hasPermission(mockPermissions);

    expect(result).toBe(false);
    expect(authClient.organization.hasPermission).toHaveBeenCalledWith({
      permissions: mockPermissions,
    });
  });

  it("should return false when API call fails", async () => {
    const mockPermissions: Permissions = { organization: ["read"] };

    vi.mocked(authClient.organization.hasPermission).mockRejectedValue(
      new Error("API Error"),
    );

    const result = await hasPermission(mockPermissions);

    expect(result).toBe(false);
  });

  it("should return false when data is null", async () => {
    const mockPermissions: Permissions = { organization: ["read"] };

    vi.mocked(authClient.organization.hasPermission).mockResolvedValue({
      data: null,
    } as HasPermissionResponse);

    const result = await hasPermission(mockPermissions);

    expect(result).toBe(false);
  });

  it("should return false when data.success is undefined", async () => {
    const mockPermissions: Permissions = { organization: ["read"] };

    vi.mocked(authClient.organization.hasPermission).mockResolvedValue({
      data: {},
    } as HasPermissionResponse);

    const result = await hasPermission(mockPermissions);

    expect(result).toBe(false);
  });
});
