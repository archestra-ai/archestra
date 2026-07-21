import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { configSeed, publicConfigSeed } from "@/mocks/data/config";
import { useMcpSandboxDomain } from "./config.query";

// useConfig gates its fetch on isAuthenticated; drive that directly so a test
// can model the session-less offline video renderer (no session) vs a signed-in
// viewer without standing up better-auth.
const { isAuthenticatedMock } = vi.hoisted(() => ({
  isAuthenticatedMock: vi.fn<() => boolean>(),
}));
vi.mock("@/lib/auth/auth.hook", () => ({
  useIsAuthenticated: () => isAuthenticatedMock(),
}));

describe("useMcpSandboxDomain", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // Seeded, fresh cache entries mean neither query refetches on mount, so the
  // hook resolves purely from what each config source is primed with.
  const renderWithCache = (seed: {
    authenticated: boolean;
    authedDomain?: string | null;
    publicDomain?: string | null;
  }) => {
    isAuthenticatedMock.mockReturnValue(seed.authenticated);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    if (seed.authedDomain !== undefined) {
      queryClient.setQueryData(["config"], {
        ...configSeed,
        features: {
          ...configSeed.features,
          mcpSandboxDomain: seed.authedDomain,
        },
      });
    }
    if (seed.publicDomain !== undefined) {
      queryClient.setQueryData(["public-config"], {
        ...publicConfigSeed,
        mcpSandboxDomain: seed.publicDomain,
      });
    }
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    return renderHook(() => useMcpSandboxDomain(), { wrapper });
  };

  it("falls back to the public config when there is no session (the offline video renderer)", () => {
    // The authenticated config never loads without a session, so only the
    // public config carries the sandbox origin here. Without this fallback the
    // renderer frames the sandbox at the frontend origin and the backend
    // refuses it with a 403.
    const { result } = renderWithCache({
      authenticated: false,
      publicDomain: "sandbox.archestra.dev",
    });

    expect(result.current).toBe("sandbox.archestra.dev");
  });

  it("prefers the authenticated config value when a session is present", () => {
    const { result } = renderWithCache({
      authenticated: true,
      authedDomain: "sandbox.archestra.dev",
      publicDomain: "stale.example.com",
    });

    expect(result.current).toBe("sandbox.archestra.dev");
  });

  it("is null when no sandbox domain is configured on either source", () => {
    const { result } = renderWithCache({
      authenticated: false,
      publicDomain: null,
    });

    expect(result.current).toBeNull();
  });
});
