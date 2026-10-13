import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  useHasPermissions,
  useScopedCapabilities,
  useSession,
} from "@/lib/auth/auth.query";
import { useFeature } from "@/lib/config/config.query";
import { fetchCatalogTools } from "@/lib/mcp/internal-mcp-catalog.query";
import { InitialAgentSelector } from "./initial-agent-selector";

const {
  agents,
  mockUseAgentCredentialReadiness,
  mockUseAgentDelegations,
  mockAssignTool,
  mockUseAllProfileTools,
  mockUseConnectors,
  mockUseMcpServersGroupedByCatalog,
  mockUseInternalMcpCatalog,
  mockUseKnowledgeBases,
  mockUseMcpInstallOrchestrator,
  mockUseProfile,
} = vi.hoisted(() => ({
  agents: [
    {
      id: "agent-1",
      name: "Alpha Agent",
      agentType: "agent",
      scope: "org",
      authorId: null,
      description: null,
      icon: null,
      systemPrompt: null,
      runtime: null,
      accessAllTools: true,
    },
    {
      id: "agent-2",
      name: "Beta Agent",
      agentType: "agent",
      scope: "org",
      authorId: null,
      description: null,
      icon: null,
      systemPrompt: null,
      runtime: null,
      accessAllTools: true,
    },
    {
      id: "agent-3",
      name: "Gamma Agent",
      agentType: "agent",
      scope: "org",
      authorId: null,
      description: null,
      icon: null,
      systemPrompt: null,
      runtime: null,
      accessAllTools: true,
    },
  ],
  mockAssignTool: vi.fn((_variables: unknown) => Promise.resolve({})),
  mockUseMcpServersGroupedByCatalog: vi.fn(
    (): Record<string, unknown[]> | undefined => ({}),
  ),
  mockUseAgentCredentialReadiness: vi.fn((_options?: unknown) => ({
    data: undefined,
  })),
  mockUseAgentDelegations: vi.fn((_agentId?: string, _options?: unknown) => ({
    data: [],
  })),
  mockUseAllProfileTools: vi.fn((_options?: unknown) => ({
    data: { data: [] },
  })),
  mockUseConnectors: vi.fn((_options?: unknown) => ({ data: [] })),
  mockUseInternalMcpCatalog: vi.fn((_options?: unknown) => ({ data: [] })),
  mockUseKnowledgeBases: vi.fn((_options?: unknown) => ({ data: [] })),
  mockUseMcpInstallOrchestrator: vi.fn((_options?: unknown) => ({
    closeLocalInstall: vi.fn(),
    closeNoAuthInstall: vi.fn(),
    closeOAuth: vi.fn(),
    handleLocalServerInstallConfirm: vi.fn(),
    handleNoAuthConfirm: vi.fn(),
    handleOAuthConfirm: vi.fn(),
    handleRemoteServerInstallConfirm: vi.fn(),
    isDialogOpened: () => false,
    isInstalling: false,
    isReauth: false,
    localServerCatalogItem: null,
    noAuthCatalogItem: null,
    selectedCatalogItem: null,
    triggerInstallByCatalogId: vi.fn(),
  })),
  mockUseProfile: vi.fn((id: string | undefined, _options?: unknown) => ({
    data: agents.find((agent) => agent.id === id),
  })),
}));

vi.mock("@/lib/auth/auth.query");
vi.mock("@/lib/config/config.query");

vi.mock("@/lib/agent.query", () => ({
  useAgentCredentialReadiness: (options?: unknown) =>
    mockUseAgentCredentialReadiness(options),
  useChatAgents: () => ({ data: agents }),
  useCreateProfile: () => ({ mutate: vi.fn() }),
  useInternalAgents: () => ({ data: agents }),
  useProfile: (id: string | undefined, options?: unknown) =>
    mockUseProfile(id, options),
  useUpdateProfile: () => ({ mutate: vi.fn() }),
}));

vi.mock("@/lib/agent-tools.query", () => ({
  useAgentDelegations: (agentId?: string, options?: unknown) =>
    mockUseAgentDelegations(agentId, options),
  useAllProfileTools: (options?: unknown) => mockUseAllProfileTools(options),
  useAssignTool: () => ({ mutate: vi.fn(), mutateAsync: mockAssignTool }),
  useRemoveAgentDelegation: () => ({ mutate: vi.fn() }),
  useSyncAgentDelegations: () => ({ mutate: vi.fn() }),
  useUnassignTool: () => ({ mutate: vi.fn() }),
}));

vi.mock("@/lib/agent-tools.hook", () => ({
  useInvalidateToolAssignmentQueries: () => vi.fn(),
}));

vi.mock("@/lib/mcp/mcp-server.query", () => ({
  useMcpServers: () => ({ data: [] }),
  useMcpServersGroupedByCatalog: () => mockUseMcpServersGroupedByCatalog(),
}));

vi.mock("@/lib/knowledge/connector.query", () => ({
  useConnectors: (options?: unknown) => mockUseConnectors(options),
}));

vi.mock("@/lib/knowledge/knowledge-base.query", () => ({
  useKnowledgeBases: (options?: unknown) => mockUseKnowledgeBases(options),
}));

vi.mock("@/lib/mcp/internal-mcp-catalog.query", () => ({
  useMcpCatalogCredentialPreflight: () => ({ data: [] }),
  fetchCatalogTools: vi.fn(),
  useCatalogTools: () => ({ data: [] }),
  useInternalMcpCatalog: (options?: unknown) =>
    mockUseInternalMcpCatalog(options),
}));

vi.mock("@/lib/mcp/mcp-install-orchestrator.hook", () => ({
  useMcpInstallOrchestrator: (options?: unknown) =>
    mockUseMcpInstallOrchestrator(options),
}));

vi.mock("@/components/chat/mcp-install-dialogs", () => ({
  McpInstallDialogs: () => null,
}));
vi.mock("@/app/mcp/registry/_parts/local-server-install-dialog", () => ({
  LocalServerInstallDialog: () => null,
}));
vi.mock("@/app/mcp/registry/_parts/no-auth-install-dialog", () => ({
  NoAuthInstallDialog: () => null,
}));
vi.mock("@/app/mcp/registry/_parts/remote-server-install-dialog", () => ({
  RemoteServerInstallDialog: () => null,
}));
vi.mock("@/components/oauth-confirmation-dialog", () => ({
  OAuthConfirmationDialog: () => null,
}));

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
  Element.prototype.hasPointerCapture = vi.fn();
  Element.prototype.releasePointerCapture = vi.fn();
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

beforeEach(() => {
  vi.mocked(useHasPermissions).mockReturnValue({ data: true } as ReturnType<
    typeof useHasPermissions
  >);
  vi.mocked(useSession).mockReturnValue({
    data: { user: { id: "user-1" } },
  } as ReturnType<typeof useSession>);
  vi.mocked(useFeature).mockReturnValue(false);
});

describe("InitialAgentSelector keyboard navigation", () => {
  it("moves through agents with arrow keys and selects with Enter", async () => {
    const user = userEvent.setup();
    const onAgentChange = vi.fn();
    render(
      <InitialAgentSelector
        currentAgentId="agent-1"
        onAgentChange={onAgentChange}
      />,
    );

    await user.click(screen.getByRole("combobox"));
    const search = await screen.findByRole("combobox", {
      name: "Search agents",
    });

    expect(search).toHaveAttribute(
      "aria-activedescendant",
      screen.getByRole("option", { name: /Alpha Agent/ }).id,
    );

    await user.keyboard("{ArrowDown}");
    expect(search).toHaveFocus();
    expect(search).toHaveAttribute(
      "aria-activedescendant",
      screen.getByRole("option", { name: /Beta Agent/ }).id,
    );

    await user.keyboard("{ArrowUp}");
    expect(search).toHaveAttribute(
      "aria-activedescendant",
      screen.getByRole("option", { name: /Alpha Agent/ }).id,
    );

    await user.keyboard("{ArrowUp}{Enter}");
    expect(onAgentChange).toHaveBeenCalledWith("agent-3");
  });

  it("keeps typing after navigation and selects a newly filtered agent", async () => {
    const user = userEvent.setup();
    const onAgentChange = vi.fn();
    render(
      <InitialAgentSelector
        currentAgentId="agent-1"
        onAgentChange={onAgentChange}
      />,
    );
    await user.click(screen.getByRole("combobox"));
    await user.keyboard("{ArrowDown}gamma");
    const search = screen.getByRole("combobox", { name: "Search agents" });
    expect(search).toHaveFocus();
    expect(search).toHaveValue("gamma");
    expect(search).toHaveAttribute(
      "aria-activedescendant",
      screen.getByRole("option", { name: /Gamma Agent/ }).id,
    );
    await user.keyboard("{Enter}");
    expect(onAgentChange).toHaveBeenCalledExactlyOnceWith("agent-3");
  });

  it("defers management queries until the picker opens", async () => {
    const user = userEvent.setup();
    render(
      <InitialAgentSelector currentAgentId="agent-1" onAgentChange={vi.fn()} />,
    );

    expect(mockUseAgentCredentialReadiness).toHaveBeenLastCalledWith({
      enabled: false,
    });
    expect(mockUseInternalMcpCatalog).toHaveBeenLastCalledWith({
      enabled: false,
    });
    expect(mockUseKnowledgeBases).toHaveBeenLastCalledWith({ enabled: false });
    expect(mockUseConnectors).toHaveBeenLastCalledWith({ enabled: false });
    expect(mockUseProfile).toHaveBeenCalledWith("agent-1", { enabled: false });

    await user.click(screen.getByRole("combobox"));

    expect(mockUseAgentCredentialReadiness).toHaveBeenLastCalledWith({
      enabled: true,
    });
    expect(mockUseInternalMcpCatalog).toHaveBeenLastCalledWith({
      enabled: true,
    });
    expect(mockUseKnowledgeBases).toHaveBeenLastCalledWith({ enabled: true });
    expect(mockUseConnectors).toHaveBeenLastCalledWith({ enabled: true });
    expect(mockUseProfile).toHaveBeenCalledWith("agent-1", { enabled: true });
    // The server icons come from the agent detail; the full tool-assignment
    // list (every tool's schema) is only for the edit dialog.
    expect(mockUseAllProfileTools).not.toHaveBeenCalled();
  });
});

describe("InitialAgentSelector quick-edit dialog", () => {
  const catalog = {
    id: "catalog-1",
    name: "Everything",
    description: null,
    serverType: "local",
    icon: null,
  };
  // A fresh install is owned personally by default, and the backend refuses
  // to pin a personal connection statically.
  const personalInstall = {
    "catalog-1": [{ id: "personal-install", scope: "personal" }],
  };

  beforeEach(() => {
    mockUseInternalMcpCatalog.mockReturnValue({ data: [catalog] } as never);
    vi.mocked(fetchCatalogTools).mockResolvedValue([
      { id: "tool-a" },
      { id: "tool-b" },
    ] as never);
    mockUseProfile.mockImplementation((id) => {
      const agent = agents.find((a) => a.id === id);
      return { data: agent && { ...agent, accessAllTools: false } };
    });
    vi.mocked(useScopedCapabilities).mockReturnValue({
      data: [{ resource: "agent", action: "update", scope: "*" }],
    } as unknown as ReturnType<typeof useScopedCapabilities>);
  });

  it("adds every tool of a personally-installed server with call-time credentials", async () => {
    mockUseMcpServersGroupedByCatalog.mockReturnValue(personalInstall);
    const user = userEvent.setup();
    renderSelector();

    await openAddTools(user);
    await user.click(await screen.findByRole("button", { name: /Everything/ }));

    await waitFor(() => expect(mockAssignTool).toHaveBeenCalledTimes(2));
    expectDynamicAssignments();
  });

  it("adds a server's tools once the install started from the dialog completes", async () => {
    mockUseMcpServersGroupedByCatalog.mockReturnValue({});
    const triggerInstallByCatalogId = vi.fn();
    mockUseMcpInstallOrchestrator.mockReturnValue({
      ...mockUseMcpInstallOrchestrator(),
      triggerInstallByCatalogId,
    });
    const user = userEvent.setup();
    const { rerender } = renderSelector();

    await openAddTools(user);
    await user.click(await screen.findByRole("button", { name: /Everything/ }));
    expect(triggerInstallByCatalogId).toHaveBeenCalledWith("catalog-1");
    expect(mockAssignTool).not.toHaveBeenCalled();

    mockUseMcpServersGroupedByCatalog.mockReturnValue(personalInstall);
    rerender(selectorTree());

    await waitFor(() => expect(mockAssignTool).toHaveBeenCalledTimes(2));
    expectDynamicAssignments();
  });
});

const queryClient = new QueryClient();

function selectorTree() {
  return (
    <QueryClientProvider client={queryClient}>
      <InitialAgentSelector currentAgentId="agent-1" onAgentChange={vi.fn()} />
    </QueryClientProvider>
  );
}

function renderSelector() {
  queryClient.clear();
  mockAssignTool.mockClear();
  return render(selectorTree());
}

async function openAddTools(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("combobox"));
  const [editButton] = screen.getAllByRole("button", { name: "Edit" });
  await user.click(editButton);
  await user.click(await screen.findByRole("button", { name: "Add" }));
}

function expectDynamicAssignments() {
  for (const [variables] of mockAssignTool.mock.calls) {
    expect(variables).toMatchObject({
      agentId: "agent-1",
      resolveAtCallTime: true,
      credentialResolutionMode: "dynamic",
    });
    expect(variables).not.toHaveProperty("mcpServerId");
  }
}
