import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useDefaultMcpGateway, useProfilesPaginated } from "@/lib/agent.query";
import { useHasPermissions, useSession } from "@/lib/auth/auth.query";
import { useOrganization } from "@/lib/organization.query";
import { useMyTeams } from "@/lib/teams/team.query";
import McpGatewaysPage from "./page.client";

vi.mock("next/navigation");
vi.mock("@/lib/auth/auth.query");
vi.mock("@/lib/organization.query");
vi.mock("@/lib/teams/team.query");
vi.mock("@/lib/hooks/use-app-name");
vi.mock("@/lib/agent.query", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/agent.query")>()),
  useProfilesPaginated: vi.fn(),
  useLabelKeys: () => ({ data: [] }),
  useLabelValues: () => ({ data: [] }),
  useAllMatchingProfiles: () => ({ fetchAll: vi.fn(), isFetching: false }),
  useBulkDeleteProfiles: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useDeleteProfile: () => ({ mutate: vi.fn(), isPending: false }),
  usePermanentlyDeleteProfile: () => ({ mutate: vi.fn(), isPending: false }),
  usePinAgent: () => ({ mutate: vi.fn(), isPending: false }),
  useRestoreProfile: () => ({ mutate: vi.fn(), isPending: false }),
  useDefaultMcpGateway: vi.fn(() => ({ data: null, isLoading: false })),
  useProfile: () => ({ data: null }),
}));

const pinnedGateway = {
  id: "gw-pinned",
  name: "Pinned gateway",
  agentType: "mcp_gateway",
  lastUsedAt: null,
  accessAllTools: true,
  tools: [],
  pinned: true,
  teams: [],
  labels: [],
};

describe("McpGatewaysPage", () => {
  beforeEach(() => {
    vi.mocked(usePathname).mockReturnValue("/mcp/gateways");
    vi.mocked(useSearchParams).mockReturnValue(
      new URLSearchParams() as unknown as ReturnType<typeof useSearchParams>,
    );
    vi.mocked(useRouter).mockReturnValue({
      push: vi.fn(),
      replace: vi.fn(),
      prefetch: vi.fn(),
    } as unknown as ReturnType<typeof useRouter>);
    vi.mocked(useHasPermissions).mockReturnValue({
      data: true,
      isPending: false,
    } as ReturnType<typeof useHasPermissions>);
    vi.mocked(useSession).mockReturnValue({
      data: { user: { id: "user-1" } },
    } as ReturnType<typeof useSession>);
    vi.mocked(useOrganization).mockReturnValue({
      data: { connectionDefaultMcpGatewayId: null },
    } as unknown as ReturnType<typeof useOrganization>);
    vi.mocked(useMyTeams).mockReturnValue({
      data: [],
    } as unknown as ReturnType<typeof useMyTeams>);
  });

  // The list loads in the browser now, and its pin section often lands first.
  // The table must hold its place instead of vanishing until the list arrives.
  it.each([
    false,
    true,
  ])("keeps the gateway table on screen while the list is still loading (automatic pins loading: %s)", (autoPinsLoading) => {
    vi.mocked(useDefaultMcpGateway).mockReturnValue({
      data: autoPinsLoading ? undefined : null,
      isLoading: autoPinsLoading,
    } as unknown as ReturnType<typeof useDefaultMcpGateway>);
    vi.mocked(useProfilesPaginated).mockImplementation(
      (params) =>
        (params?.pinned === true
          ? {
              data: {
                data: [pinnedGateway],
                pagination: { total: 1, limit: 100, offset: 0 },
              },
              isPending: false,
              isFetching: false,
              isLoadingError: false,
            }
          : {
              data: undefined,
              isPending: true,
              isFetching: true,
              isLoadingError: false,
            }) as unknown as ReturnType<typeof useProfilesPaginated>,
    );

    render(
      <QueryClientProvider
        client={
          new QueryClient({ defaultOptions: { queries: { retry: false } } })
        }
      >
        <McpGatewaysPage />
      </QueryClientProvider>,
    );

    expect(screen.getByText("Pinned gateway")).toBeVisible();
    expect(screen.getByText("All gateways")).toBeVisible();
    expect(screen.queryByText("No MCP gateways found")).toBeNull();
  });

  // A page asked for before the pins are known would include the personal
  // gateway, which would then flash as a table row.
  it.each([
    false,
    true,
  ])("asks for the table only once the automatic pins are known (automatic pins loading: %s)", (autoPinsLoading) => {
    vi.mocked(useDefaultMcpGateway).mockReturnValue({
      data: autoPinsLoading ? undefined : { id: "gw-personal" },
      isLoading: autoPinsLoading,
    } as unknown as ReturnType<typeof useDefaultMcpGateway>);
    vi.mocked(useProfilesPaginated).mockClear();
    vi.mocked(useProfilesPaginated).mockReturnValue({
      data: undefined,
      isPending: true,
      isFetching: false,
      isLoadingError: false,
    } as unknown as ReturnType<typeof useProfilesPaginated>);

    render(
      <QueryClientProvider
        client={
          new QueryClient({ defaultOptions: { queries: { retry: false } } })
        }
      >
        <McpGatewaysPage />
      </QueryClientProvider>,
    );

    const tableCall = vi
      .mocked(useProfilesPaginated)
      .mock.calls.map(([params]) => params)
      .find((params) => params?.pinned === false);
    expect(tableCall?.enabled).toBe(!autoPinsLoading);
    if (!autoPinsLoading) {
      expect(tableCall?.excludeIds).toEqual(["gw-personal"]);
    }
  });
});
