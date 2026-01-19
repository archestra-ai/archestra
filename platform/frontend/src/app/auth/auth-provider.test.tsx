import { archestraApiSdk, type Permissions } from "@shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { authClient } from "@/lib/clients/auth/auth-client";
import { useArchestraHasPermission } from "./auth-provider";

// Mock the auth client and SDK
vi.mock("@/lib/clients/auth/auth-client", () => ({
  authClient: {
    getSession: vi.fn(),
    useSession: vi.fn(),
    organization: {
      listMembers: vi.fn(),
    },
  },
}));

vi.mock("@shared", async () => {
  const actual = await vi.importActual("@shared");
  return {
    ...actual,
    archestraApiSdk: {
      getDefaultCredentialsStatus: vi.fn(),
      getUserPermissions: vi.fn(),
    },
  };
});

vi.mock("@/lib/auth.utils", () => ({
  hasPermission: vi.fn(),
}));

// Helper to wrap hooks with QueryClient
const createWrapper = () => {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  });
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
};

// Clear mocks before each test
beforeEach(() => {
  vi.clearAllMocks();

  // Default mock for authClient.useSession - returns authenticated state
  vi.mocked(authClient.useSession).mockReturnValue({
    data: {
      user: { id: "test-user", email: "test@example.com" },
      session: { id: "test-session" },
    },
  } as ReturnType<typeof authClient.useSession>);
});

describe("useArchestraHasPermission", () => {
  it("should handle 'permissions' (plural) parameter", async () => {
    const userPermissions: Permissions = {
      invitation: ["create", "cancel"],
    };

    vi.mocked(archestraApiSdk.getUserPermissions).mockResolvedValue({
      data: userPermissions,
    } as Awaited<ReturnType<typeof archestraApiSdk.getUserPermissions>>);

    const { result } = renderHook(
      () =>
        useArchestraHasPermission({
          organizationId: "org-123",
          permissions: { invitation: ["create"] },
        }),
      { wrapper: createWrapper() },
    );

    await waitFor(() => {
      expect(result.current.isPending).toBe(false);
    });

    expect(result.current.data).toEqual({ success: true, error: null });
  });

  it("should handle 'permission' (singular) parameter", async () => {
    const userPermissions: Permissions = {
      member: ["update"],
    };

    vi.mocked(archestraApiSdk.getUserPermissions).mockResolvedValue({
      data: userPermissions,
    } as Awaited<ReturnType<typeof archestraApiSdk.getUserPermissions>>);

    const { result } = renderHook(
      () =>
        useArchestraHasPermission({
          organizationId: "org-123",
          permission: { member: ["update"] },
        }),
      { wrapper: createWrapper() },
    );

    await waitFor(() => {
      expect(result.current.isPending).toBe(false);
    });

    expect(result.current.data).toEqual({ success: true, error: null });
  });

  it("should prefer 'permissions' over 'permission' when both provided", async () => {
    const userPermissions: Permissions = {
      invitation: ["create"],
      member: ["update"],
    };

    vi.mocked(archestraApiSdk.getUserPermissions).mockResolvedValue({
      data: userPermissions,
    } as Awaited<ReturnType<typeof archestraApiSdk.getUserPermissions>>);

    // When both are provided, 'permissions' should take precedence
    const { result } = renderHook(
      () =>
        useArchestraHasPermission({
          organizationId: "org-123",
          permissions: { invitation: ["create"] },
          permission: { member: ["update"] },
        }),
      { wrapper: createWrapper() },
    );

    await waitFor(() => {
      expect(result.current.isPending).toBe(false);
    });

    // Should check invitation (from permissions) not member (from permission)
    expect(result.current.data).toEqual({ success: true, error: null });
  });

  it("should return success: false when user lacks required permissions", async () => {
    const userPermissions: Permissions = {
      invitation: [],
    };

    vi.mocked(archestraApiSdk.getUserPermissions).mockResolvedValue({
      data: userPermissions,
    } as Awaited<ReturnType<typeof archestraApiSdk.getUserPermissions>>);

    const { result } = renderHook(
      () =>
        useArchestraHasPermission({
          organizationId: "org-123",
          permissions: { invitation: ["create"] },
        }),
      { wrapper: createWrapper() },
    );

    await waitFor(() => {
      expect(result.current.isPending).toBe(false);
    });

    expect(result.current.data).toEqual({ success: false, error: null });
  });

  it("should return success: true when no permissions are specified", async () => {
    const userPermissions: Permissions = {};

    vi.mocked(archestraApiSdk.getUserPermissions).mockResolvedValue({
      data: userPermissions,
    } as Awaited<ReturnType<typeof archestraApiSdk.getUserPermissions>>);

    const { result } = renderHook(
      () =>
        useArchestraHasPermission({
          organizationId: "org-123",
        }),
      { wrapper: createWrapper() },
    );

    await waitFor(() => {
      expect(result.current.isPending).toBe(false);
    });

    expect(result.current.data).toEqual({ success: true, error: null });
  });

  it("should return correct format for better-auth-ui compatibility", async () => {
    const userPermissions: Permissions = {
      invitation: ["create"],
    };

    vi.mocked(archestraApiSdk.getUserPermissions).mockResolvedValue({
      data: userPermissions,
    } as Awaited<ReturnType<typeof archestraApiSdk.getUserPermissions>>);

    const { result } = renderHook(
      () =>
        useArchestraHasPermission({
          organizationId: "org-123",
          permissions: { invitation: ["create"] },
        }),
      { wrapper: createWrapper() },
    );

    await waitFor(() => {
      expect(result.current.isPending).toBe(false);
    });

    // Verify the return format matches what better-auth-ui expects:
    // { data: { success: boolean, error: null }, isPending: boolean }
    expect(result.current).toHaveProperty("data");
    expect(result.current).toHaveProperty("isPending");
    expect(result.current.data).toHaveProperty("success");
    expect(result.current.data).toHaveProperty("error");
    expect(result.current.data.error).toBe(null);
  });

  it("should handle admin invitation permissions for invite member button", async () => {
    // This test simulates the exact scenario from the GitHub issue
    // where an admin user should have invitation:create permission
    const adminPermissions: Permissions = {
      invitation: ["create", "cancel"],
      member: ["read", "update", "delete"],
      organization: ["read", "update"],
    };

    vi.mocked(archestraApiSdk.getUserPermissions).mockResolvedValue({
      data: adminPermissions,
    } as Awaited<ReturnType<typeof archestraApiSdk.getUserPermissions>>);

    // This is the exact call made by OrganizationMembersCard in better-auth-ui
    const { result } = renderHook(
      () =>
        useArchestraHasPermission({
          organizationId: "org-123",
          permissions: { invitation: ["create"] },
        }),
      { wrapper: createWrapper() },
    );

    await waitFor(() => {
      expect(result.current.isPending).toBe(false);
    });

    // The "Invite Member" button should be enabled (success: true)
    expect(result.current.data.success).toBe(true);
  });
});
