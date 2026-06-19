import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockUseInternalAgents, mockUseHasPermissions } = vi.hoisted(() => ({
  mockUseInternalAgents: vi.fn(),
  mockUseHasPermissions: vi.fn(),
}));

global.ResizeObserver = vi.fn().mockImplementation(() => ({
  observe: vi.fn(),
  unobserve: vi.fn(),
  disconnect: vi.fn(),
}));

const emptyQuery = { data: undefined, isLoading: false, isPending: false };
const emptyListQuery = { data: [], isLoading: false, isPending: false };
const noopMutation = {
  mutate: vi.fn(),
  mutateAsync: vi.fn(),
  isPending: false,
};

vi.mock("@tanstack/react-query", async (importOriginal) => {
  const actual = await importOriginal<object>();
  return { ...actual, useQueries: () => [] };
});

vi.mock("@/lib/agent.query", () => ({
  useInternalAgents: () => mockUseInternalAgents(),
  useCreateProfile: () => noopMutation,
  useUpdateProfile: () => noopMutation,
}));

vi.mock("@/lib/auth/auth.query", () => ({
  useHasPermissions: () => mockUseHasPermissions(),
  useSession: () => ({ data: { user: { id: "user-1" } } }),
}));

vi.mock("@/lib/agent-tools.query", () => ({
  useAgentDelegations: () => emptyListQuery,
  useAllProfileTools: () => emptyListQuery,
  useAssignTool: () => noopMutation,
  useRemoveAgentDelegation: () => noopMutation,
  useSyncAgentDelegations: () => noopMutation,
  useUnassignTool: () => noopMutation,
}));

vi.mock("@/lib/agent-tools.hook", () => ({
  useInvalidateToolAssignmentQueries: () => vi.fn(),
}));

vi.mock("@/lib/knowledge/connector.query", () => ({
  useConnectors: () => emptyListQuery,
}));

vi.mock("@/lib/knowledge/knowledge-base.query", () => ({
  useKnowledgeBases: () => emptyListQuery,
}));

vi.mock("@/lib/mcp/internal-mcp-catalog.query", () => ({
  useInternalMcpCatalog: () => emptyListQuery,
  useCatalogTools: () => emptyListQuery,
  fetchCatalogTools: vi.fn(),
}));

vi.mock("@/lib/mcp/mcp-install-orchestrator.hook", () => ({
  useMcpInstallOrchestrator: () => ({
    triggerInstallByCatalogId: vi.fn(),
    triggerReauthByCatalogIdAndServerId: vi.fn(),
    isDialogOpened: () => false,
    selectedCatalogItem: null,
    localServerCatalogItem: null,
    noAuthCatalogItem: null,
    manageCatalogId: null,
    isInstalling: false,
    isReauth: false,
    handleRemoteServerInstallConfirm: vi.fn(),
    handleLocalServerInstallConfirm: vi.fn(),
    handleNoAuthConfirm: vi.fn(),
    handleOAuthConfirm: vi.fn(),
    handleManageDialogClose: vi.fn(),
    closeRemoteInstall: vi.fn(),
    closeLocalInstall: vi.fn(),
    closeNoAuth: vi.fn(),
    closeOAuth: vi.fn(),
  }),
}));

vi.mock("@/lib/mcp/mcp-server.query", () => ({
  useMcpServers: () => emptyListQuery,
  useMcpServersGroupedByCatalog: () => ({}),
}));

vi.mock("@/lib/mcp/archestra-mcp-server", () => ({
  useArchestraMcpIdentity: () => ({ catalogName: "Archestra" }),
}));

vi.mock("@/lib/hooks/use-app-name", () => ({
  useAppName: () => "Archestra",
}));

import { InitialAgentSelector } from "./initial-agent-selector";

function withClient(node: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return <QueryClientProvider client={client}>{node}</QueryClientProvider>;
}

describe("InitialAgentSelector", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseHasPermissions.mockReturnValue(emptyQuery);
  });

  it("renders the placeholder without throwing when no agents are available", () => {
    mockUseInternalAgents.mockReturnValue(emptyListQuery);

    expect(() =>
      render(
        withClient(
          <InitialAgentSelector
            currentAgentId={null}
            onAgentChange={vi.fn()}
          />,
        ),
      ),
    ).not.toThrow();

    expect(screen.getByText("Select agent")).toBeInTheDocument();
  });

  it("renders the placeholder for an RBAC-zero list even with a current id set", () => {
    // No agent the user may pick: the list is empty but a stale id is supplied.
    mockUseInternalAgents.mockReturnValue(emptyListQuery);
    mockUseHasPermissions.mockReturnValue(emptyQuery);

    expect(() =>
      render(
        withClient(
          <InitialAgentSelector
            currentAgentId="stale-agent-id"
            onAgentChange={vi.fn()}
          />,
        ),
      ),
    ).not.toThrow();

    expect(screen.getByText("Select agent")).toBeInTheDocument();
  });
});
