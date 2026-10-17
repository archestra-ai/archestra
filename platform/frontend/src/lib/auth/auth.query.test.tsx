import { archestraApiSdk, type Permissions } from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  authQueryKeys,
  useDefaultCredentialsEnabled,
  useHasPermissions,
  usePermissionMap,
  useSession,
} from "@/lib/auth/auth.query";
import * as authUtils from "@/lib/auth/auth.utils";
import { authClient } from "@/lib/clients/auth/auth-client";

// Mock the auth client and SDK
vi.mock("@/lib/clients/auth/auth-client");

vi.mock("@archestra/shared", async () => {
  const actual = await vi.importActual("@archestra/shared");
  return {
    ...actual,
    archestraApiSdk: {
      getDefaultCredentialsStatus: vi.fn(),
      getUserPermissions: vi.fn(),
      getScopedCapabilities: vi.fn(),
    },
  };
});

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
  vi.mocked(archestraApiSdk.getScopedCapabilities).mockResolvedValue({
    data: [],
    error: undefined,
    request: new Request("http://localhost"),
    response: new Response(),
  } as Awaited<ReturnType<typeof archestraApiSdk.getScopedCapabilities>>);

  vi.mocked(authClient.getSession).mockResolvedValue({
    data: {
      user: { id: "test-user", email: "test@example.com" },
      session: { id: "test-session" },
    },
  } as Awaited<ReturnType<typeof authClient.getSession>>);
});

describe("useSession", () => {
  it("keeps authenticated navigation visible when a session refresh fails", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const session = {
      user: { id: "viewer", email: "viewer@example.com" },
      session: { id: "viewer-session" },
    };
    queryClient.setQueryData(authQueryKeys.session(), session);
    queryClient.setQueryData(authQueryKeys.userPermissions(), {
      project: ["read"],
    });
    queryClient.setQueryData(authQueryKeys.scopedCapabilities(), []);
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(
      () => {
        const sessionQuery = useSession();
        const permissions = usePermissionMap({
          projects: { project: ["read"] },
        });
        return {
          sessionQuery,
          showNavigation:
            !!sessionQuery.data?.user && permissions?.projects === true,
        };
      },
      { wrapper },
    );
    await waitFor(() => expect(result.current.showNavigation).toBe(true));
    expect(result.current.sessionQuery.isRefetchError).toBe(false);
    vi.mocked(authClient.getSession).mockResolvedValue({
      data: null,
      error: {
        status: 503,
        statusText: "Service Unavailable",
        message: "Temporary outage",
      },
    } as Awaited<ReturnType<typeof authClient.getSession>>);
    await act(async () => {
      await result.current.sessionQuery.refetch();
    });
    await waitFor(() =>
      expect(result.current.sessionQuery.isRefetchError).toBe(true),
    );
    expect(result.current.sessionQuery.data).toEqual(session);
    expect(result.current.showNavigation).toBe(true);
  });

  it.each([
    null,
    401,
    403,
  ])("clears the cached session when signed out or explicitly unauthorized (%s)", async (status) => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    queryClient.setQueryData(authQueryKeys.session(), {
      user: { id: "viewer" },
      session: { id: "viewer-session" },
    });
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(() => useSession(), { wrapper });
    expect(result.current.data?.user).toBeDefined();
    vi.mocked(authClient.getSession).mockResolvedValue({
      data: null,
      error: status === null ? null : { status, statusText: "Unauthorized" },
    } as Awaited<ReturnType<typeof authClient.getSession>>);
    await act(async () => {
      await result.current.refetch();
    });
    await waitFor(() => expect(result.current.data).toBeNull());
    expect(result.current.isSuccess).toBe(true);
  });

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
  it("delegates evaluation to hasPermissions", async () => {
    const hasPermissionsSpy = vi.spyOn(authUtils, "hasPermissions");
    const userPermissions: Permissions = {
      organization: ["read"],
    };

    vi.mocked(archestraApiSdk.getUserPermissions).mockResolvedValue({
      data: userPermissions,
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

    expect(hasPermissionsSpy).toHaveBeenCalledWith(
      userPermissions,
      permissionsToCheck,
    );
    expect(result.current.data).toBe(true);
  });

  it("should return true when user has all required permissions", async () => {
    const userPermissions: Permissions = {
      organization: ["read", "create", "update"],
      agent: ["read", "create"],
    };

    vi.mocked(archestraApiSdk.getUserPermissions).mockResolvedValue({
      data: userPermissions,
    } as Awaited<ReturnType<typeof archestraApiSdk.getUserPermissions>>);

    const permissionsToCheck: Permissions = {
      organization: ["read", "create"],
      agent: ["read"],
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
      agent: ["read"],
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
      agent: ["read"], // User doesn't have agent resource at all
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
    expect(authClient.getSession).toHaveBeenCalledTimes(1);
    expect(archestraApiSdk.getUserPermissions).toHaveBeenCalledTimes(1);
  });
});

describe("usePermissionMap", () => {
  it("shows known role links while scoped capabilities load", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    queryClient.setQueryData(authQueryKeys.session(), {
      user: { id: "viewer", email: "viewer@example.com" },
      session: { id: "viewer-session" },
    });
    queryClient.setQueryData(authQueryKeys.userPermissions(), {
      project: ["read"],
    });
    const capabilitiesMock = vi.mocked(
      archestraApiSdk.getScopedCapabilities<false>,
    );
    type CapabilitiesResult = Awaited<
      Parameters<typeof capabilitiesMock.mockReturnValue>[0]
    >;
    let resolveCapabilities!: (value: CapabilitiesResult) => void;
    capabilitiesMock.mockReturnValue(
      new Promise<CapabilitiesResult>((resolve) => {
        resolveCapabilities = resolve;
      }),
    );
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(
      () =>
        usePermissionMap({
          projects: { project: ["read"] },
          skills: { skill: ["read"] },
        }),
      { wrapper },
    );
    await waitFor(() =>
      expect(result.current).toEqual({ projects: true, skills: false }),
    );
    await act(async () => {
      resolveCapabilities({
        data: [
          {
            organizationId: "org-1",
            resource: "skill",
            scope: "00000000-0000-4000-8000-000000000001",
            action: "read",
          },
        ],
        error: undefined,
        request: new Request("http://localhost"),
        response: new Response(),
      });
    });
    await waitFor(() =>
      expect(result.current).toEqual({ projects: true, skills: true }),
    );
  });

  it("allows discovery through an object grant without widening mutation permissions", async () => {
    vi.mocked(archestraApiSdk.getUserPermissions).mockResolvedValue({
      data: { organization: ["read"] },
      error: undefined,
      request: new Request("http://localhost"),
      response: new Response(),
    } as Awaited<ReturnType<typeof archestraApiSdk.getUserPermissions>>);
    vi.mocked(archestraApiSdk.getScopedCapabilities).mockResolvedValue({
      data: [
        {
          organizationId: "org-1",
          resource: "agent",
          scope: "00000000-0000-4000-8000-000000000001",
          action: "read",
        },
      ],
    } as Awaited<ReturnType<typeof archestraApiSdk.getScopedCapabilities>>);
    const { result } = renderHook(
      () =>
        usePermissionMap({
          canReadOrg: { organization: ["read"] },
          canReadAgent: { agent: ["read"] },
          canEditAgent: { agent: ["update"] },
          canReadSkill: { skill: ["read"] },
        }),
      { wrapper: createWrapper() },
    );
    await waitFor(() =>
      expect(result.current).toEqual({
        canReadOrg: true,
        canReadAgent: true,
        canEditAgent: false,
        canReadSkill: false,
      }),
    );
  });

  it("should check multiple permission sets and return a map of results", async () => {
    const userPermissions: Permissions = {
      organization: ["read", "create"],
      agent: ["read"],
    };

    vi.mocked(archestraApiSdk.getUserPermissions).mockResolvedValue({
      data: userPermissions,
    } as Awaited<ReturnType<typeof archestraApiSdk.getUserPermissions>>);

    const permissionMap: Record<string, Permissions> = {
      canReadOrg: { organization: ["read"] },
      canCreateOrg: { organization: ["create"] },
      canDeleteOrg: { organization: ["delete"] }, // User doesn't have this
      canReadAgent: { agent: ["read"] },
      canCreateAgent: { agent: ["create"] }, // User doesn't have this
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
      canReadAgent: true,
      canCreateAgent: false,
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

it("reports only unmet actions while honoring a grant on the requested resource", async () => {
  vi.mocked(archestraApiSdk.getUserPermissions).mockResolvedValue({
    data: { chat: ["read"], openappaDiagnostics: ["read", "admin"] },
    error: undefined,
    request: new Request("http://localhost"),
    response: new Response(),
  } as Awaited<ReturnType<typeof archestraApiSdk.getUserPermissions>>);
  vi.mocked(archestraApiSdk.getScopedCapabilities).mockResolvedValue({
    data: [{ resource: "agent", action: "read", scope: "config-agent" }],
  } as Awaited<ReturnType<typeof archestraApiSdk.getScopedCapabilities>>);
  const { result } = renderHook(
    () =>
      useHasPermissions(
        {
          chat: ["read", "create"],
          agent: ["read", "update"],
          openappaDiagnostics: ["read"],
        },
        "config-agent",
      ),
    { wrapper: createWrapper() },
  );
  await waitFor(() => expect(result.current.isPending).toBe(false));
  expect(result.current.data).toBe(false);
  expect(result.current.missingPermissions).toEqual({
    chat: ["create"],
    agent: ["update"],
  });
});
