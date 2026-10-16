import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
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
  mockServerTools,
  mockUseAgentCredentialReadiness,
  mockUseAgentDelegations,
  mockUseAllProfileTools,
  mockUseConnectors,
  mockUseMcpServersGroupedByCatalog,
  mockUseInternalMcpCatalog,
  mockUseKnowledgeBases,
  mockUseMcpInstallOrchestrator,
  mockUseProfile,
  mockPinnedIds,
  mockSwitchAccess,
  mockChatRoster,
  mockFetchNextPage,
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
  mockServerTools: vi.fn((_variables: unknown) => Promise.resolve({})),
  mockUseMcpServersGroupedByCatalog: vi.fn(
    (): Record<string, unknown[]> | undefined => ({}),
  ),
  mockUseAgentCredentialReadiness: vi.fn((_options?: unknown) => ({
    data: undefined,
  })),
  mockUseAgentDelegations: vi.fn((_agentId?: string, _options?: unknown) => ({
    data: [],
    isSuccess: true,
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
    isDialogOpened: (_key: string): boolean => false,
    isInstalling: false,
    isReauth: false,
    localServerCatalogItem: null as unknown,
    noAuthCatalogItem: null,
    selectedCatalogItem: null,
    triggerInstallByCatalogId: vi.fn(),
  })),
  mockUseProfile: vi.fn((id: string | undefined, _options?: unknown) => ({
    data: agents.find((agent) => agent.id === id),
  })),
  mockPinnedIds: [] as string[],
  mockSwitchAccess: vi.fn((_params: unknown) => {}),
  mockChatRoster: { hasNextPage: false },
  mockFetchNextPage: vi.fn(),
}));

vi.mock("@/lib/auth/auth.query");
vi.mock("@/lib/config/config.query");

vi.mock("@/lib/agent.query", () => ({
  useAgentCredentialReadiness: (options?: unknown) =>
    mockUseAgentCredentialReadiness(options),
  useAgentSearch: ({
    name,
    enabled,
  }: {
    name?: string;
    enabled?: boolean;
  }) => ({
    // Mirrors the server-side name search: only typed text narrows the page.
    data: enabled
      ? agents.filter((agent) =>
          agent.name.toLowerCase().includes((name ?? "").toLowerCase()),
        )
      : undefined,
  }),
  useChatAgents: () => ({ data: agents }),
  useChatAgentPage: () => ({
    data: {
      pages: [
        { data: agents, pagination: { hasNext: false, nextCursor: null } },
      ],
    },
    isPending: false,
    isError: false,
    isFetchingNextPage: false,
    hasNextPage: mockChatRoster.hasNextPage,
    fetchNextPage: mockFetchNextPage,
  }),
  useChatAgentReferences: (ids: string[]) => ({
    data: agents.filter((agent) => ids.includes(agent.id)),
  }),
  useCreateProfile: () => ({ mutate: vi.fn() }),
  useInternalAgentOptions: () => ({ data: agents }),
  usePinnedAgentIds: () => ({ data: mockPinnedIds }),
  useProfile: (id: string | undefined, options?: unknown) =>
    mockUseProfile(id, options),
  useSwitchAgentAccess: () => ({
    switchAccess: mockSwitchAccess,
    isPending: false,
  }),
  useUpdateProfile: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock("@/lib/agent-tools.query", () => ({
  ServerToolsUpdateError: class extends Error {},
  useAgentDelegations: (agentId?: string, options?: unknown) =>
    mockUseAgentDelegations(agentId, options),
  useAllProfileTools: (options?: unknown) => mockUseAllProfileTools(options),
  useRemoveAgentDelegation: () => ({ mutate: vi.fn(), isPending: false }),
  useSyncAgentDelegations: () => ({ mutate: vi.fn(), isPending: false }),
  useUpdateAgentServerTools: () => ({
    mutate: vi.fn(),
    mutateAsync: mockServerTools,
    isPending: false,
  }),
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
// The registry's install forms have their own tests; here a stand-in submits
// so the dialog's own connect-then-add flow can be followed.
vi.mock("@/app/mcp/registry/_parts/local-server-install-dialog", () => ({
  LocalServerInstallDialog: ({
    onConfirm,
  }: {
    onConfirm: (result: unknown) => Promise<void>;
  }) => (
    <button type="button" onClick={() => onConfirm({ catalogId: "catalog-1" })}>
      Install
    </button>
  ),
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
vi.mock("@/components/system-prompt-editor", () => ({
  SystemPromptEditor: ({
    title,
    value,
    onChange,
  }: {
    title: string;
    value: string;
    onChange: (value: string) => void;
  }) => (
    <textarea
      aria-label={title}
      value={value}
      onChange={(event) => onChange(event.target.value)}
    />
  ),
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
  mockPinnedIds.splice(0);
});

describe("InitialAgentSelector keyboard navigation", () => {
  it("moves through agents with arrow keys and selects with Enter", async () => {
    const user = userEvent.setup();
    const onAgentChange = vi.fn();
    renderSelector({ onAgentChange });

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
    renderSelector({ onAgentChange });
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

  it("lists the user's pinned agents first, under their own heading", async () => {
    mockPinnedIds.push("agent-3");
    const user = userEvent.setup();
    renderSelector();

    await user.click(screen.getByRole("combobox"));

    const pinned = await screen.findByRole("group", { name: "Pinned" });
    expect(within(pinned).getAllByRole("option")).toEqual([
      screen.getByRole("option", { name: /Gamma Agent/ }),
    ]);
    expect(screen.getAllByRole("option")[0]).toHaveAccessibleName(
      /Gamma Agent/,
    );
  });

  it("loads the trigger's icon data only after the first paint", async () => {
    renderSelector();

    // The first render must not compete with the composer's first paint.
    expect(mockUseInternalMcpCatalog).toHaveBeenNthCalledWith(1, {
      enabled: false,
    });
    expect(mockUseProfile).toHaveBeenNthCalledWith(1, "agent-1", {
      enabled: false,
    });

    await waitFor(() =>
      expect(mockUseInternalMcpCatalog).toHaveBeenLastCalledWith({
        enabled: true,
      }),
    );
    expect(mockUseProfile).toHaveBeenCalledWith("agent-1", { enabled: true });
    // Readiness is for the picker; the trigger never pays for it.
    expect(mockUseAgentCredentialReadiness).toHaveBeenLastCalledWith(
      expect.objectContaining({ enabled: false }),
    );
    // The server icons come from the agent detail; the full tool-assignment
    // list (every tool's schema) is only for the edit dialog.
    expect(mockUseAllProfileTools).not.toHaveBeenCalledWith(
      expect.objectContaining({ enabled: true }),
    );
  });
});

describe("InitialAgentSelector agent paging", () => {
  beforeEach(() => {
    mockChatRoster.hasNextPage = false;
    mockFetchNextPage.mockClear();
  });

  it("has no Previous or Next controls", async () => {
    const user = userEvent.setup();
    renderSelector();

    await user.click(screen.getByRole("combobox"));
    await screen.findByRole("combobox", { name: "Search agents" });

    expect(screen.queryByRole("button", { name: "Previous" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Next" })).toBeNull();
  });

  it("loads the next page only once the list is scrolled near its end", async () => {
    mockChatRoster.hasNextPage = true;
    const user = userEvent.setup();
    renderSelector();

    await user.click(screen.getByRole("combobox"));
    const listbox = await screen.findByRole("listbox", { name: "Agents" });
    Object.defineProperty(listbox, "scrollHeight", { value: 1000 });
    Object.defineProperty(listbox, "clientHeight", { value: 320 });

    Object.defineProperty(listbox, "scrollTop", { value: 0, writable: true });
    fireEvent.scroll(listbox);
    expect(mockFetchNextPage).not.toHaveBeenCalled();

    Object.defineProperty(listbox, "scrollTop", { value: 600, writable: true });
    fireEvent.scroll(listbox);
    expect(mockFetchNextPage).toHaveBeenCalledTimes(1);
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
  const personalInstall = {
    "catalog-1": [{ id: "personal-install", scope: "personal" }],
  };

  beforeEach(() => {
    mockServerTools.mockClear();
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

  it("adds every tool of a connected server in one step", async () => {
    mockUseMcpServersGroupedByCatalog.mockReturnValue(personalInstall);
    const user = userEvent.setup();
    renderSelector();

    const dialog = await openAddTools(user);
    await user.click(
      await within(dialog).findByRole("button", { name: "Add all" }),
    );

    await waitFor(() =>
      expect(mockServerTools).toHaveBeenCalledExactlyOnceWith({
        agentId: "agent-1",
        add: ["tool-a", "tool-b"],
        remove: [],
        builtIn: false,
        undoToast: { agentName: "Alpha Agent", serverName: "Everything" },
      }),
    );
    // Back on the settings, with the server it just added.
    expect(
      await screen.findByRole("heading", { name: /Instructions|Tools/ }),
    ).toBeInTheDocument();
  });

  it("shows the agent's tools as part of its button, which opens the picker", async () => {
    mockUseProfile.mockImplementation((id) => {
      const agent = agents.find((a) => a.id === id);
      return {
        data: agent && {
          ...agent,
          accessAllTools: false,
          tools: [{ catalogId: "catalog-1" }, { catalogId: "catalog-1" }],
        },
      };
    });
    const loaded = { data: [], isSuccess: true } as never;
    mockUseInternalMcpCatalog.mockReturnValue({
      data: [catalog],
      isSuccess: true,
    } as never);
    mockUseKnowledgeBases.mockReturnValue(loaded);
    mockUseConnectors.mockReturnValue(loaded);
    const user = userEvent.setup();
    renderSelector();

    const trigger = screen.getByRole("combobox", { name: "Alpha Agent" });
    await waitFor(() =>
      expect(trigger).toHaveAccessibleDescription(
        "Alpha Agent uses 1 tool server",
      ),
    );
    // No second control beside it: the icons are the agent button's.
    expect(
      screen.queryByRole("button", { name: /uses 1 tool server/ }),
    ).not.toBeInTheDocument();

    await user.click(trigger);
    expect(screen.getByRole("listbox", { name: "Agents" })).toBeVisible();
    expect(
      screen.queryByRole("dialog", { name: "Alpha Agent settings" }),
    ).not.toBeInTheDocument();
  });

  it("starts loading the dialog's data when the edit button is hovered", async () => {
    const user = userEvent.setup();
    renderSelector();

    await user.click(screen.getByRole("combobox"));
    mockUseAllProfileTools.mockClear();
    await user.hover(screen.getByRole("button", { name: "Edit Alpha Agent" }));

    expect(mockUseProfile).toHaveBeenCalledWith("agent-1", undefined);
    expect(mockUseAllProfileTools).toHaveBeenCalledWith({
      filters: { agentId: "agent-1" },
      skipPagination: true,
      enabled: true,
    });
    expect(mockUseAgentDelegations).toHaveBeenCalledWith("agent-1", undefined);
    // Hovering alone does not open it.
    expect(
      screen.queryByRole("dialog", { name: "Alpha Agent settings" }),
    ).not.toBeInTheDocument();
  });

  it("switches the agent to All tools from its settings", async () => {
    mockSwitchAccess.mockClear();
    const user = userEvent.setup();
    renderSelector();

    await user.click(screen.getByRole("combobox"));
    await user.click(screen.getByRole("button", { name: "Edit Alpha Agent" }));
    const dialog = await screen.findByRole("dialog");
    const toolAccess = within(dialog).getByRole("tablist", {
      name: "Tool access",
    });
    await user.click(within(toolAccess).getByRole("tab", { name: "All" }));

    expect(mockSwitchAccess).toHaveBeenCalledTimes(1);
    expect(mockSwitchAccess.mock.calls[0]?.[0]).toMatchObject({
      agent: { id: "agent-1" },
      target: "tools",
      all: true,
    });
  });

  it("connects a server inside the dialog, then adds its tools", async () => {
    mockUseMcpServersGroupedByCatalog.mockReturnValue({});
    const triggerInstallByCatalogId = vi.fn();
    // The registry's own install; the server shows up once it lands.
    const handleLocalServerInstallConfirm = vi.fn(async () => {
      mockUseMcpServersGroupedByCatalog.mockReturnValue(personalInstall);
    });
    mockUseMcpInstallOrchestrator.mockReturnValue({
      ...mockUseMcpInstallOrchestrator(),
      triggerInstallByCatalogId,
      handleLocalServerInstallConfirm,
      isDialogOpened: (key: string) => key === "local-install",
      localServerCatalogItem: catalog,
    });
    const user = userEvent.setup();
    renderSelector();

    const dialog = await openAddTools(user);
    await user.click(within(dialog).getByRole("button", { name: "Connect" }));
    expect(triggerInstallByCatalogId).toHaveBeenCalledWith("catalog-1");
    expect(mockServerTools).not.toHaveBeenCalled();

    await user.click(within(dialog).getByRole("button", { name: "Install" }));

    await waitFor(() =>
      expect(mockServerTools).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          agentId: "agent-1",
          add: ["tool-a", "tool-b"],
          builtIn: false,
        }),
      ),
    );
  });
});

const queryClient = new QueryClient();

function renderSelector(props?: { onAgentChange?: (id: string) => void }) {
  queryClient.clear();
  return render(
    <QueryClientProvider client={queryClient}>
      <InitialAgentSelector
        currentAgentId="agent-1"
        onAgentChange={props?.onAgentChange ?? vi.fn()}
      />
    </QueryClientProvider>,
  );
}

async function openAddTools(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("combobox"));
  await user.click(screen.getByRole("button", { name: "Edit Alpha Agent" }));
  const dialog = await screen.findByRole("dialog");
  await user.click(within(dialog).getByRole("button", { name: "Add tools" }));
  return dialog;
}
