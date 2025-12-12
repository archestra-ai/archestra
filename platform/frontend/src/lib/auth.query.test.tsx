import { archestraApiSdk } from "@shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  useCurrentOrgMembers,
  useDefaultCredentialsEnabled,
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
