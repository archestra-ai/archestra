import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { authQueryKeys } from "@/lib/auth/auth.query";
import { authClient } from "@/lib/clients/auth/auth-client";
import {
  organizationKeys,
  useActiveMemberRole,
  useIsGlobalAdmin,
} from "@/lib/organization.query";

vi.mock("@/lib/clients/auth/auth-client");

function renderWithClient<T>(hook: () => T) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );

  return { ...renderHook(hook, { wrapper }), queryClient };
}

function renderActiveMemberRole() {
  return renderWithClient(() => useActiveMemberRole());
}

function sessionWith(activeOrganizationId: string | null) {
  return {
    data: {
      user: { id: "user-1", email: "user@example.com" },
      session: { id: "session-1", activeOrganizationId },
    },
    error: null,
  };
}

describe("useActiveMemberRole", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authClient.organization.getActiveMemberRole).mockResolvedValue({
      data: { role: "admin" },
      error: null,
    });
  });

  it("fetches the role from the session alone, without an organization fetch in front", async () => {
    vi.mocked(authClient.getSession).mockResolvedValue(sessionWith("org-1"));

    const { result } = renderActiveMemberRole();

    await waitFor(() => {
      expect(result.current.data).toBe("admin");
    });
    // The endpoint derives the organization from the session, so the hook must
    // not consult the organization store (whose fetch would then gate the role).
    expect(authClient.useActiveOrganization).not.toHaveBeenCalled();
  });

  it("does not fire while the session is still resolving", async () => {
    let resolveSession: (value: unknown) => void = () => {};
    vi.mocked(authClient.getSession).mockReturnValue(
      new Promise((resolve) => {
        resolveSession = resolve;
      }),
    );

    const { result } = renderActiveMemberRole();

    expect(authClient.organization.getActiveMemberRole).not.toHaveBeenCalled();

    resolveSession(sessionWith("org-1"));

    await waitFor(() => {
      expect(result.current.data).toBe("admin");
    });
  });

  it("resolves to null, not undefined, when the endpoint reports no role", async () => {
    vi.mocked(authClient.getSession).mockResolvedValue(sessionWith("org-1"));
    vi.mocked(authClient.organization.getActiveMemberRole).mockResolvedValue({
      data: undefined,
      error: null,
    });

    const { result } = renderActiveMemberRole();

    // null is the settled "no role" answer; undefined would be
    // indistinguishable from a query that has not resolved yet.
    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });
    expect(result.current.data).toBeNull();
  });

  it("does not serve one organization's cached role after a switch of the active org", async () => {
    vi.mocked(authClient.getSession).mockResolvedValue(sessionWith("org-1"));

    const { result, queryClient } = renderActiveMemberRole();
    await waitFor(() => {
      expect(result.current.data).toBe("admin");
    });

    vi.mocked(authClient.organization.getActiveMemberRole).mockResolvedValue({
      data: { role: "member" },
      error: null,
    });
    act(() => {
      queryClient.setQueryData(
        authQueryKeys.session(),
        sessionWith("org-2").data,
      );
    });

    await waitFor(() => {
      expect(result.current.data).toBe("member");
    });
    // Each organization keeps its own cache entry; org-1's was not overwritten.
    expect(
      queryClient.getQueryData(organizationKeys.activeMemberRole("org-1")),
    ).toBe("admin");
  });

  it("never fires for a session with no active organization", async () => {
    vi.mocked(authClient.getSession).mockResolvedValue(sessionWith(null));

    const { result } = renderActiveMemberRole();

    // The session settling is the last thing that could enable the query.
    await waitFor(() => {
      expect(authClient.getSession).toHaveBeenCalled();
    });
    expect(result.current.isPending).toBe(true);
    expect(authClient.organization.getActiveMemberRole).not.toHaveBeenCalled();
  });
});

describe("useIsGlobalAdmin", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authClient.organization.getActiveMemberRole).mockResolvedValue({
      data: { role: "admin" },
      error: null,
    });
  });

  it("reports loading — not 'not an admin' — while the session is still resolving", async () => {
    let resolveSession: (value: unknown) => void = () => {};
    vi.mocked(authClient.getSession).mockReturnValue(
      new Promise((resolve) => {
        resolveSession = resolve;
      }),
    );

    const { result } = renderWithClient(() => useIsGlobalAdmin());

    // The role query is disabled until the session names an organization, so
    // its own isLoading is false here. Reading that as a settled answer would
    // tell a real admin they lack the role for as long as the session takes.
    expect(result.current.isGlobalAdmin).toBe(false);
    expect(result.current.isLoading).toBe(true);

    resolveSession(sessionWith("org-1"));

    await waitFor(() => {
      expect(result.current.isGlobalAdmin).toBe(true);
    });
    expect(result.current.isLoading).toBe(false);
  });

  it("settles on 'not an admin' for a session with no active organization", async () => {
    vi.mocked(authClient.getSession).mockResolvedValue(sessionWith(null));

    const { result } = renderWithClient(() => useIsGlobalAdmin());

    // Nothing further can resolve a role, and the API answers such a caller
    // the same way, so this is an answer rather than a request in flight.
    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });
    expect(result.current.isGlobalAdmin).toBe(false);
  });

  it("is not an admin for a custom role, however broad", async () => {
    vi.mocked(authClient.getSession).mockResolvedValue(sessionWith("org-1"));
    vi.mocked(authClient.organization.getActiveMemberRole).mockResolvedValue({
      data: { role: "project-auditor" },
      error: null,
    });

    const { result } = renderWithClient(() => useIsGlobalAdmin());

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });
    expect(result.current.isGlobalAdmin).toBe(false);
  });
});
