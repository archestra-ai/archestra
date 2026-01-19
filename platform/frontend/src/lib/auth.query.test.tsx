import { archestraApiSdk, type Permissions } from "@shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  useCurrentOrgMembers,
  useDefaultCredentialsEnabled,
  useHasPermissions,
  usePermissionMap,
  useSession,
} from "./auth.query";
import { authClient } from "./clients/auth/auth-client";

// Mock the auth client and SDK
vi.mock("./clients/auth/auth-client", () => ({
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

vi.mock("./auth.utils", () => ({
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

describe("useSession", () => {
  it("should return session data", async () => {
    const mockSession = {
      user: { id: "user123", email: "test@example.com" },
      session: { id: "session123" },
    };

    vi.mocked(authClient.getSession).mockResolvedValue({
      data: mockSession,
    } as ReturnType<typeof authClient.getSession>);

    const { result } = renderHook(() => useSession(), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(result.current.data).toEqual(mockSession);
    expect(authClient.getSession).toHaveBeenCalled();
  });
});

describe("useCurrentOrgMembers", () => {
  it("should return organization members", async () => {
    const mockMembers = [
      { id: "user1", email: "user1@example.com", role: "admin" },
      { id: "user2", email: "user2@example.com", role: "member" },
    ];

    vi.mocked(authClient.organization.listMembers).mockResolvedValue({
      data: { members: mockMembers },
    } as ReturnType<typeof authClient.organization.listMembers>);

    const { result } = renderHook(() => useCurrentOrgMembers(), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(result.current.data).toEqual(mockMembers);
  });
});

describe("useDefaultCredentialsEnabled", () => {
  it("should return default credentials status", async () => {
    vi.mocked(archestraApiSdk.getDefaultCredentialsStatus).mockResolvedValue({
      data: { enabled: true },
    } as Awaited<
      ReturnType<typeof archestraApiSdk.getDefaultCredentialsStatus>
    >);

    const { result } = renderHook(() => useDefaultCredentialsEnabled(), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(result.current.data).toBe(true);
  });
});

describe("useHasPermissions", () => {
  it("should return true when user has all required permissions", async () => {
    const userPermissions: Permissions = {
      organization: ["read", "create", "update"],
      profile: ["read", "create"],
    };

    vi.mocked(archestraApiSdk.getUserPermissions).mockResolvedValue({
      data: userPermissions,
    } as Awaited<ReturnType<typeof archestraApiSdk.getUserPermissions>>);

    const permissionsToCheck: Permissions = {
      organization: ["read", "create"],
      profile: ["read"],
    };

    const { result } = renderHook(() => useHasPermissions(permissionsToCheck), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(result.current.data).toBe(true);
  });

  it("should return false when user is missing required permissions", async () => {
    const userPermissions: Permissions = {
      organization: ["read"],
      profile: ["read"],
    };

    vi.mocked(archestraApiSdk.getUserPermissions).mockResolvedValue({
      data: userPermissions,
    } as Awaited<ReturnType<typeof archestraApiSdk.getUserPermissions>>);

    const permissionsToCheck: Permissions = {
      organization: ["read", "delete"], // User doesn't have "delete"
    };

    const { result } = renderHook(() => useHasPermissions(permissionsToCheck), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(result.current.data).toBe(false);
  });

  it("should return false when user is missing entire resource", async () => {
    const userPermissions: Permissions = {
      organization: ["read"],
    };

    vi.mocked(archestraApiSdk.getUserPermissions).mockResolvedValue({
      data: userPermissions,
    } as Awaited<ReturnType<typeof archestraApiSdk.getUserPermissions>>);

    const permissionsToCheck: Permissions = {
      profile: ["read"], // User doesn't have profile resource at all
    };

    const { result } = renderHook(() => useHasPermissions(permissionsToCheck), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(result.current.data).toBe(false);
  });

  it("should return true when no permissions are required", async () => {
    const userPermissions: Permissions = {
      organization: ["read"],
    };

    vi.mocked(archestraApiSdk.getUserPermissions).mockResolvedValue({
      data: userPermissions,
    } as Awaited<ReturnType<typeof archestraApiSdk.getUserPermissions>>);

    const { result } = renderHook(() => useHasPermissions({}), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(result.current.data).toBe(true);
  });

  it("should return false when permissions are not loaded yet", async () => {
    vi.mocked(archestraApiSdk.getUserPermissions).mockResolvedValue({
      data: {},
    } as Awaited<ReturnType<typeof archestraApiSdk.getUserPermissions>>);

    const permissionsToCheck: Permissions = {
      organization: ["read"],
    };

    const { result } = renderHook(() => useHasPermissions(permissionsToCheck), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(result.current.data).toBe(false);
  });

  it("should share the same query across multiple hook calls", async () => {
    const userPermissions: Permissions = {
      organization: ["read", "create"],
    };

    vi.mocked(archestraApiSdk.getUserPermissions).mockResolvedValue({
      data: userPermissions,
    } as Awaited<ReturnType<typeof archestraApiSdk.getUserPermissions>>);

    const wrapper = createWrapper();

    // Render two hooks with different permission checks
    const { result: result1 } = renderHook(
      () => useHasPermissions({ organization: ["read"] }),
      { wrapper },
    );

    const { result: result2 } = renderHook(
      () => useHasPermissions({ organization: ["create"] }),
      { wrapper },
    );

    await waitFor(() => {
      expect(result1.current.isSuccess).toBe(true);
      expect(result2.current.isSuccess).toBe(true);
    });

    // Both should have evaluated to true
    expect(result1.current.data).toBe(true);
    expect(result2.current.data).toBe(true);

    // But getUserPermissions should only have been called once
    expect(archestraApiSdk.getUserPermissions).toHaveBeenCalledTimes(1);
  });
});

describe("usePermissionMap", () => {
  it("should check multiple permission sets and return a map of results", async () => {
    const userPermissions: Permissions = {
      organization: ["read", "create"],
      profile: ["read"],
    };

    vi.mocked(archestraApiSdk.getUserPermissions).mockResolvedValue({
      data: userPermissions,
    } as Awaited<ReturnType<typeof archestraApiSdk.getUserPermissions>>);

    const permissionMap: Record<string, Permissions> = {
      canReadOrg: { organization: ["read"] },
      canCreateOrg: { organization: ["create"] },
      canDeleteOrg: { organization: ["delete"] }, // User doesn't have this
      canReadProfile: { profile: ["read"] },
      canCreateProfile: { profile: ["create"] }, // User doesn't have this
    };

    const { result } = renderHook(() => usePermissionMap(permissionMap), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(result.current?.canReadOrg).toBe(true);
    });

    expect(result.current).toEqual({
      canReadOrg: true,
      canCreateOrg: true,
      canDeleteOrg: false,
      canReadProfile: true,
      canCreateProfile: false,
    });
  });

  it("should return true for keys with no required permissions", async () => {
    const userPermissions: Permissions = {
      organization: ["read"],
    };

    vi.mocked(archestraApiSdk.getUserPermissions).mockResolvedValue({
      data: userPermissions,
    } as Awaited<ReturnType<typeof archestraApiSdk.getUserPermissions>>);

    const permissionMap: Record<string, Permissions> = {
      noPermissionsRequired: {},
      hasPermissions: { organization: ["read"] },
    };

    const { result } = renderHook(() => usePermissionMap(permissionMap), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(result.current?.hasPermissions).toBe(true);
    });

    expect(result.current?.noPermissionsRequired).toBe(true);
    expect(result.current?.hasPermissions).toBe(true);
  });

  it("should return false for all keys when permissions are not loaded", async () => {
    vi.mocked(archestraApiSdk.getUserPermissions).mockResolvedValue({
      data: {},
    } as Awaited<ReturnType<typeof archestraApiSdk.getUserPermissions>>);

    const permissionMap: Record<string, Permissions> = {
      canRead: { organization: ["read"] },
      canCreate: { organization: ["create"] },
    };

    const { result } = renderHook(() => usePermissionMap(permissionMap), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      // Wait for query to settle
      expect(result.current?.canRead).toBeDefined();
    });

    expect(result.current?.canRead).toBe(false);
    expect(result.current?.canCreate).toBe(false);
  });
});
