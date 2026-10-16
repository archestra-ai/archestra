import { archestraApiSdk } from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock ResizeObserver which is used by Radix UI components
global.ResizeObserver = vi.fn().mockImplementation(() => ({
  observe: vi.fn(),
  unobserve: vi.fn(),
  disconnect: vi.fn(),
}));

const {
  mockRouterPush,
  mockDeleteMutate,
  mockUseConversations,
  mockUseMyAgentRuns,
  mockUseAgentOptions,
  mockUseInternalMcpCatalog,
  mockUseSkillsList,
  mockUseApps,
  mockUseProjects,
  mockUseKnowledgeBases,
  mockUsePlugins,
  mockUseEnvironments,
  mockUseTeams,
} = vi.hoisted(() => ({
  mockRouterPush: vi.fn(),
  mockDeleteMutate: vi.fn(),
  mockUseConversations: vi.fn(),
  mockUseMyAgentRuns: vi.fn(),
  mockUseAgentOptions: vi.fn(),
  mockUseInternalMcpCatalog: vi.fn(),
  mockUseSkillsList: vi.fn(),
  mockUseApps: vi.fn(),
  mockUseProjects: vi.fn(),
  mockUseKnowledgeBases: vi.fn(),
  mockUsePlugins: vi.fn(),
  mockUseEnvironments: vi.fn(),
  mockUseTeams: vi.fn(),
}));

// Legacy behavior fixtures remain local; real HTTP paging is covered by the
// remote-selector integration suite.
vi.mock("@/lib/agent-options.query", () => ({
  useAgentOptionsByIds: (params: unknown) => mockUseAgentOptions(params),
  useAgentOptionIds: () => ({
    data: (mockUseAgentOptions({}).data ?? []).map(
      (row: { id: string }) => row.id,
    ),
    isSuccess: true,
  }),
  useAgentOptionsPage: (params: { search?: string }) => {
    const result = mockUseAgentOptions(params);
    const search = params.search?.trim().toLowerCase() ?? "";
    const rows = (result.data ?? []).filter(
      (row: {
        name?: string;
        description?: string | null;
        authorEmail?: string | null;
      }) =>
        !search ||
        [row.name, row.description, row.authorEmail].some((value) =>
          value?.toLowerCase().includes(search),
        ),
    );
    return {
      data: {
        pages: [
          { data: rows, pagination: { hasNext: false, nextCursor: null } },
        ],
      },
      isSuccess: true,
      isLoading: false,
      isPending: false,
      isError: false,
      hasNextPage: false,
      isFetchingNextPage: false,
      fetchNextPage: vi.fn(),
      refetch: vi.fn(),
    };
  },
}));

vi.mock("next/navigation");

vi.mock("@uidotdev/usehooks", () => ({
  useDebounce: (value: string) => value,
}));

vi.mock("@/lib/hooks/use-platform", () => ({
  usePlatform: () => ({ modKey: "⌘", altKey: "⌥", isMac: true }),
}));

vi.mock("@/lib/auth/auth.hook", () => ({
  useIsAuthenticated: () => true,
}));

vi.mock("@/lib/auth/auth.query");
// Read only when a grant on one credential might open Settings.
vi.mock("@/lib/runtime-credentials.query", () => ({
  useRuntimeCredentials: () => ({ data: [], isPending: false }),
}));

vi.mock("@/lib/config/config.query");

vi.mock("@/lib/chat/chat-utils", () => ({
  getConversationDisplayTitle: (title: string | null) =>
    title ?? "Untitled chat",
}));

vi.mock("@/lib/chat/chat.query", () => ({
  useConversations: mockUseConversations,
  useDeleteConversation: () => ({
    mutate: mockDeleteMutate,
  }),
  usePinConversation: () => ({
    mutate: vi.fn(),
  }),
}));

let useRealRunsQuery = false;
vi.mock("@archestra/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@archestra/shared")>();
  return {
    ...actual,
    archestraApiSdk: { ...actual.archestraApiSdk, getMyAgentRuns: vi.fn() },
  };
});
vi.mock("@/lib/agent-runtime.query", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/agent-runtime.query")>();
  return {
    useMyAgentRuns: (...args: Parameters<typeof actual.useMyAgentRuns>) =>
      useRealRunsQuery
        ? // biome-ignore lint/correctness/useHookAtTopLevel: Test implementation is selected before mounting.
          actual.useMyAgentRuns(...args)
        : mockUseMyAgentRuns(...args),
  };
});

vi.mock("@/lib/agent.query", () => ({
  useAgentOptions: mockUseAgentOptions,
}));

vi.mock("@/lib/mcp/internal-mcp-catalog.query", () => ({
  useInternalMcpCatalog: mockUseInternalMcpCatalog,
}));

vi.mock("@/lib/skills/skill.query", () => ({
  useSkillsList: mockUseSkillsList,
}));

vi.mock("@/lib/app.query", () => ({
  APPS_FIRST_PAGE: { limit: 100, offset: 0 },
  useApps: mockUseApps,
}));

vi.mock("@/lib/projects/projects.query", () => ({
  useProjects: mockUseProjects,
}));

vi.mock("@/lib/knowledge/knowledge-base.query", () => ({
  useKnowledgeBases: mockUseKnowledgeBases,
}));

vi.mock("@/lib/plugins/plugin.query", () => ({
  usePlugins: mockUsePlugins,
}));

vi.mock("@/lib/environment.query", () => ({
  useEnvironments: mockUseEnvironments,
}));

vi.mock("@/lib/teams/team.query", () => ({
  useTeams: mockUseTeams,
}));

vi.mock("@/lib/secrets.query", () => ({
  useSecretsType: () => ({ data: undefined }),
}));

// Store the onValueChange callback so tests can control selectedValue
let capturedOnValueChange: ((value: string) => void) | null = null;

vi.mock("@/components/ui/command", () => ({
  CommandDialog: ({
    children,
    open,
    onValueChange,
  }: {
    children: React.ReactNode;
    open: boolean;
    onValueChange?: (value: string) => void;
  }) => {
    // Capture the callback so tests can simulate selection
    capturedOnValueChange = onValueChange ?? null;
    return open ? <div data-testid="command-dialog">{children}</div> : null;
  },
  CommandInput: ({
    value,
    onValueChange,
    placeholder,
  }: {
    value: string;
    onValueChange: (v: string) => void;
    placeholder: string;
  }) => (
    <input
      data-testid="command-input"
      placeholder={placeholder}
      value={value}
      onChange={(e) => onValueChange(e.target.value)}
    />
  ),
  CommandList: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  CommandEmpty: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  CommandGroup: ({
    children,
    heading,
  }: {
    children: React.ReactNode;
    heading?: string;
  }) => (
    <div>
      {heading && <div>{heading}</div>}
      {children}
    </div>
  ),
  CommandItem: ({
    children,
    onSelect,
    value,
  }: {
    children: React.ReactNode;
    onSelect: () => void;
    value: string;
  }) => (
    <div
      role="option"
      tabIndex={0}
      data-testid={`cmd-item-${value}`}
      onClick={onSelect}
      onKeyDown={(event) => {
        if (event.key === "Enter") onSelect();
      }}
    >
      {children}
    </div>
  ),
  CommandSeparator: () => <hr />,
}));

vi.mock("@/components/ui/badge", () => ({
  Badge: ({ children }: { children: React.ReactNode }) => (
    <span>{children}</span>
  ),
}));

import {
  predefinedPermissionsMap,
  requiredPagePermissionsMap,
} from "@archestra/shared/access-control";
import { usePathname, useRouter } from "next/navigation";
// Import component after mocks
import { act } from "react";
import { useHasPermissions, usePermissionMap } from "@/lib/auth/auth.query";
import { hasPagePermissions } from "@/lib/auth/auth.utils";
import { useFeature } from "@/lib/config/config.query";
import { ConversationSearchPalette } from "./conversation-search-palette";

describe("ConversationSearchPalette", () => {
  const defaultProps = {
    open: true,
    onOpenChange: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useRouter).mockReturnValue({
      push: mockRouterPush,
    } as unknown as ReturnType<typeof useRouter>);
    vi.mocked(useHasPermissions).mockReturnValue({
      data: true,
      isPending: false,
      isLoading: false,
    } as ReturnType<typeof useHasPermissions>);
    // The palette lists only pages the reader may open, so without a
    // permission answer it lists none. Grant everything by default; the
    // gating itself is covered by its own test below.
    vi.mocked(usePermissionMap).mockReturnValue(
      Object.fromEntries(
        Object.keys(requiredPagePermissionsMap).map((url) => [url, true]),
      ),
    );
    vi.mocked(useFeature).mockReturnValue(false);
    vi.mocked(usePathname).mockReturnValue("/chat");
    mockUseConversations.mockReturnValue({
      data: [
        {
          id: "conv-1",
          title: "First conversation",
          updatedAt: new Date().toISOString(),
          lastMessageAt: new Date().toISOString(),
          messages: [],
        },
        {
          id: "conv-2",
          title: "Second conversation",
          updatedAt: new Date().toISOString(),
          lastMessageAt: new Date().toISOString(),
          messages: [],
        },
      ],
      isLoading: false,
      isFetching: false,
    });
    useRealRunsQuery = false;
    mockUseMyAgentRuns.mockReturnValue({
      data: [],
      isLoading: false,
    });
    mockUseAgentOptions.mockReturnValue({ data: [] });
    mockUseInternalMcpCatalog.mockReturnValue({ data: [] });
    mockUseSkillsList.mockReturnValue({ data: [] });
    mockUseApps.mockReturnValue({ data: { data: [] } });
    mockUseProjects.mockReturnValue({ data: [] });
    mockUseKnowledgeBases.mockReturnValue({ data: [] });
    mockUsePlugins.mockReturnValue({ data: [] });
    mockUseEnvironments.mockReturnValue({ data: { environments: [] } });
    mockUseTeams.mockReturnValue({ data: [] });
    capturedOnValueChange = null;
  });

  it("only enables conversation fetching while open", () => {
    const { rerender } = render(
      <ConversationSearchPalette {...defaultProps} open={false} />,
    );

    expect(mockUseConversations).toHaveBeenLastCalledWith(
      expect.objectContaining({ enabled: false }),
    );

    rerender(<ConversationSearchPalette {...defaultProps} open={true} />);

    expect(mockUseConversations).toHaveBeenLastCalledWith(
      expect.objectContaining({ enabled: true }),
    );
  });

  it("renders conversations when open", () => {
    render(<ConversationSearchPalette {...defaultProps} />);

    expect(screen.getByText("First conversation")).toBeInTheDocument();
    expect(screen.getByText("Second conversation")).toBeInTheDocument();
  });

  it("shows a date bucket label on each row instead of date group headings", () => {
    render(<ConversationSearchPalette {...defaultProps} />);

    // Both mock conversations have lastMessageAt = now → one "Today" label per
    // row. With date headings there would be a single "Today" for the group.
    expect(screen.getAllByText("Today")).toHaveLength(2);
    expect(screen.queryByText("Previous 7 Days")).not.toBeInTheDocument();
    expect(screen.queryByText("Previous 30 Days")).not.toBeInTheDocument();
  });

  it("keeps New chat in place while chats load, then shows the lists", () => {
    mockUseConversations.mockReturnValue({
      data: [],
      isLoading: true,
      isFetching: true,
    });
    const { rerender } = render(
      <ConversationSearchPalette {...defaultProps} />,
    );

    expect(screen.getByText("New chat")).toBeInTheDocument();
    expect(screen.queryByText("First conversation")).not.toBeInTheDocument();
    expect(screen.queryByText("Pages")).not.toBeInTheDocument();

    mockUseConversations.mockReturnValue({
      data: [
        {
          id: "conv-1",
          title: "First conversation",
          updatedAt: new Date().toISOString(),
          lastMessageAt: new Date().toISOString(),
          messages: [],
        },
      ],
      isLoading: false,
      isFetching: false,
    });
    rerender(<ConversationSearchPalette {...defaultProps} />);

    expect(screen.getByText("First conversation")).toBeInTheDocument();
    expect(screen.getByText("Pages")).toBeInTheDocument();
  });

  it("drops the Chats heading when there are no chats under it", () => {
    mockUseConversations.mockReturnValue({
      data: [],
      isLoading: false,
      isFetching: false,
    });
    render(<ConversationSearchPalette {...defaultProps} />);

    expect(screen.queryByText("Chats")).not.toBeInTheDocument();
    // The rest of the idle view is untouched.
    expect(screen.getByText("Pages")).toBeInTheDocument();
    expect(screen.getByText("New chat")).toBeInTheDocument();
  });

  it("offers New Chat once, as its own row rather than also as a page", () => {
    mockUseConversations.mockReturnValue({
      data: [],
      isLoading: false,
      isFetching: false,
    });
    render(<ConversationSearchPalette {...defaultProps} />);

    // The action row stays; the Pages list must not repeat it as a
    // destination. (A bare text count would also catch the footer's
    // keyboard-shortcut legend, which is neither.)
    expect(screen.getByTestId("cmd-item-new-chat")).toBeInTheDocument();
    expect(screen.queryAllByTestId(/^cmd-item-\/chat\b/)).toHaveLength(0);
  });

  it("keeps the Pinned heading for pinned conversations", () => {
    mockUseConversations.mockReturnValue({
      data: [
        {
          id: "conv-1",
          title: "Pinned conversation",
          updatedAt: new Date().toISOString(),
          lastMessageAt: new Date().toISOString(),
          pinnedAt: new Date().toISOString(),
          messages: [],
        },
      ],
      isLoading: false,
      isFetching: false,
    });

    render(<ConversationSearchPalette {...defaultProps} />);

    expect(screen.getByText("Pinned")).toBeInTheDocument();
    expect(screen.getByText("Pinned conversation")).toBeInTheDocument();
    // Pinned rows show their date bucket too.
    expect(screen.getByText("Today")).toBeInTheDocument();
  });

  it("shows the lock as the only leading icon on encrypted chat rows", () => {
    mockUseConversations.mockReturnValue({
      data: [
        {
          id: "conv-locked",
          title: "Locked conversation",
          updatedAt: new Date().toISOString(),
          lastMessageAt: new Date().toISOString(),
          encryptedChat: true,
          messages: [],
        },
      ],
      isLoading: false,
      isFetching: false,
    });

    render(<ConversationSearchPalette {...defaultProps} />);

    const row = screen.getByTestId("cmd-item-conv-conv-locked");
    expect(screen.getByLabelText("Encrypted chat")).toBeInTheDocument();
    // The lock replaces the chat-bubble glyph rather than sitting next to it.
    expect(row.querySelector(".lucide-message-circle")).toBeNull();
  });

  it("loads more matching runs during search without a misleading browse paging action", async () => {
    useRealRunsQuery = true;
    vi.mocked(useFeature).mockImplementation(
      (feature) => feature === "agentRuntime",
    );
    const makeRun = (taskId: string, title: string) => ({
      taskId,
      title,
      state: "TASK_STATE_COMPLETED",
      startedAt: "2020-01-01T00:00:00Z",
      stateChangedAt: "2020-01-01T00:00:00Z",
      endedAt: "2020-01-01T00:00:00Z",
    });
    vi.mocked(archestraApiSdk.getMyAgentRuns).mockImplementation(
      async ({ query } = {}) =>
        ({
          data: {
            data: query?.pinned
              ? []
              : [
                  query?.offset
                    ? makeRun("older", "Report older")
                    : makeRun("current", "Report current"),
                ],
            pagination: { hasNext: !query?.pinned && !query?.offset },
          },
          error: undefined,
        }) as never,
    );
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <ConversationSearchPalette {...defaultProps} />
      </QueryClientProvider>,
    );
    await waitFor(() =>
      expect(screen.getByText("Report current")).toBeInTheDocument(),
    );
    expect(screen.queryByText("More runs")).not.toBeInTheDocument();
    fireEvent.change(screen.getByTestId("command-input"), {
      target: { value: "Report" },
    });
    await waitFor(() =>
      expect(screen.getByText("More runs")).toBeInTheDocument(),
    );
    expect(screen.queryByText("Report older")).not.toBeInTheDocument();
    fireEvent.click(screen.getByText("More runs"));
    await waitFor(() =>
      expect(screen.getByText("Report older")).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByText("Report older"));
    expect(mockRouterPush).toHaveBeenCalledWith("/chat/runs/older");
    queryClient.clear();
  });

  it("lists Agent Runtime sessions in the browse view and opens one", () => {
    mockUseMyAgentRuns.mockReturnValue({
      data: [
        {
          taskId: "task-1",
          title: "Nightly report run",
          state: "TASK_STATE_WORKING",
          startedAt: new Date(Date.now() - 30 * 60_000).toISOString(),
          stateChangedAt: new Date().toISOString(),
          endedAt: null,
          hardDeadlineAt: new Date(Date.now() + 24 * 60 * 60_000).toISOString(),
          lastModelActivityAt: new Date(Date.now() - 20 * 60_000).toISOString(),
          projectId: "project-1",
          projectName: "Release work",
        },
      ],
      isLoading: false,
    });

    render(<ConversationSearchPalette {...defaultProps} />);

    expect(screen.getByText("Nightly report run")).toBeInTheDocument();
    // The row carries the same liveness-aware run mark as the sidebar.
    expect(
      screen.getByLabelText("Running · quiet for 20m"),
    ).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "Open project Release work" }),
    );
    expect(mockRouterPush).toHaveBeenCalledWith("/projects/project-1");
    mockRouterPush.mockClear();

    fireEvent.click(screen.getByTestId("cmd-item-exec-task-1"));
    expect(mockRouterPush).toHaveBeenCalledWith("/chat/runs/task-1");
  });

  it("shows pinned run sessions under Pinned instead of Recent", () => {
    mockUseMyAgentRuns.mockReturnValue({
      data: [
        {
          taskId: "task-pinned",
          title: "Pinned report run",
          state: "TASK_STATE_WORKING",
          startedAt: new Date().toISOString(),
          stateChangedAt: new Date().toISOString(),
          endedAt: null,
          pinnedAt: new Date().toISOString(),
        },
      ],
      isLoading: false,
    });

    render(<ConversationSearchPalette {...defaultProps} />);

    const pinnedGroup = screen.getByText("Pinned").parentElement;
    const recentGroup = screen.getByText("Recent").parentElement;
    expect(pinnedGroup).not.toBeNull();
    expect(recentGroup).not.toBeNull();
    expect(
      within(pinnedGroup as HTMLElement).getByText("Pinned report run"),
    ).toBeInTheDocument();
    expect(
      within(recentGroup as HTMLElement).queryByText("Pinned report run"),
    ).not.toBeInTheDocument();
  });

  it("matches run sessions by title during search", () => {
    mockUseConversations.mockReturnValue({
      data: [],
      isLoading: false,
      isFetching: false,
    });
    mockUseMyAgentRuns.mockReturnValue({
      data: [
        {
          taskId: "task-1",
          title: "Nightly report run",
          state: "TASK_STATE_COMPLETED",
          startedAt: new Date().toISOString(),
          stateChangedAt: new Date().toISOString(),
          endedAt: new Date().toISOString(),
        },
      ],
      isLoading: false,
    });

    render(<ConversationSearchPalette {...defaultProps} />);

    fireEvent.change(screen.getByTestId("command-input"), {
      target: { value: "nightly" },
    });
    expect(screen.getByText("Nightly report run")).toBeInTheDocument();

    fireEvent.change(screen.getByTestId("command-input"), {
      target: { value: "does-not-match" },
    });
    expect(screen.queryByText("Nightly report run")).not.toBeInTheDocument();
    expect(screen.getByText("No chats or pages found.")).toBeInTheDocument();
  });

  describe("searching by name", () => {
    it("finds an agent by its name and opens it", () => {
      mockUseAgentOptions.mockReturnValue({
        data: [{ id: "agent-1", name: "Support Triage" }],
      });
      render(<ConversationSearchPalette {...defaultProps} />);

      fireEvent.change(screen.getByTestId("command-input"), {
        target: { value: "triage" },
      });

      expect(screen.getByText("Agents")).toBeInTheDocument();
      fireEvent.click(screen.getByText("Support Triage"));
      expect(mockRouterPush).toHaveBeenCalledWith("/agents/agent-1");
    });

    it("finds an MCP server in the registry by its name", () => {
      mockUseInternalMcpCatalog.mockReturnValue({
        data: [{ id: "cat-1", name: "GitHub MCP" }],
      });
      render(<ConversationSearchPalette {...defaultProps} />);

      fireEvent.change(screen.getByTestId("command-input"), {
        target: { value: "github" },
      });

      expect(screen.getByText("MCP Servers")).toBeInTheDocument();
      fireEvent.click(screen.getByText("GitHub MCP"));
      expect(mockRouterPush).toHaveBeenCalledWith("/mcp/registry/cat-1");
    });

    it("finds a skill through the server search and opens it", () => {
      mockUseSkillsList.mockReturnValue({
        data: [{ id: "skill-1", name: "Invoice Parser" }],
      });
      render(<ConversationSearchPalette {...defaultProps} />);

      fireEvent.change(screen.getByTestId("command-input"), {
        target: { value: "invoice" },
      });

      expect(mockUseSkillsList).toHaveBeenLastCalledWith(
        { search: "invoice" },
        expect.objectContaining({ enabled: true }),
      );
      fireEvent.click(screen.getByText("Invoice Parser"));
      expect(mockRouterPush).toHaveBeenCalledWith("/skills/skill-1");
    });

    it("finds an app through the server search and opens it on the Apps page", () => {
      mockUseApps.mockReturnValue({
        data: {
          data: [
            {
              source: "owned",
              id: "app-1",
              name: "Expense Tracker",
            },
          ],
        },
      });
      render(<ConversationSearchPalette {...defaultProps} />);

      fireEvent.change(screen.getByTestId("command-input"), {
        target: { value: "expense" },
      });

      expect(mockUseApps).toHaveBeenLastCalledWith(
        expect.objectContaining({ search: "expense" }),
        expect.objectContaining({ enabled: true }),
      );
      expect(screen.getByText("Apps")).toBeInTheDocument();
      fireEvent.click(screen.getByText("Expense Tracker"));
      expect(mockRouterPush).toHaveBeenCalledWith(
        "/apps?search=Expense%20Tracker",
      );
    });

    it("finds a project by its name and opens it", () => {
      mockUseProjects.mockReturnValue({
        data: [{ id: "proj-1", name: "Quarterly Review" }],
      });
      render(<ConversationSearchPalette {...defaultProps} />);

      fireEvent.change(screen.getByTestId("command-input"), {
        target: { value: "quarterly" },
      });

      expect(screen.getByText("Projects")).toBeInTheDocument();
      fireEvent.click(screen.getByText("Quarterly Review"));
      expect(mockRouterPush).toHaveBeenCalledWith("/projects/proj-1");
    });

    it("finds a plugin by its display name and opens it", () => {
      mockUsePlugins.mockReturnValue({
        data: [{ id: "plug-1", displayName: "Jira Helper" }],
      });
      render(<ConversationSearchPalette {...defaultProps} />);

      fireEvent.change(screen.getByTestId("command-input"), {
        target: { value: "jira" },
      });

      fireEvent.click(screen.getByText("Jira Helper"));
      expect(mockRouterPush).toHaveBeenCalledWith("/plugins/plug-1");
    });

    it("finds a settings tab by its label and by its path", () => {
      render(<ConversationSearchPalette {...defaultProps} />);

      fireEvent.change(screen.getByTestId("command-input"), {
        target: { value: "service accounts" },
      });

      expect(screen.getByText("Settings")).toBeInTheDocument();
      fireEvent.click(screen.getByText("Service Accounts"));
      expect(mockRouterPush).toHaveBeenCalledWith("/settings/service-accounts");
    });

    it("does not offer agents the reader may not read", () => {
      vi.mocked(useHasPermissions).mockImplementation(
        (permissions) =>
          ({
            data: !("agent" in permissions),
            isPending: false,
            isLoading: false,
          }) as ReturnType<typeof useHasPermissions>,
      );
      mockUseAgentOptions.mockReturnValue({
        data: [{ id: "agent-1", name: "Support Triage" }],
      });
      render(<ConversationSearchPalette {...defaultProps} />);

      expect(mockUseAgentOptions).toHaveBeenLastCalledWith(
        expect.objectContaining({ enabled: false }),
      );
    });

    it("does not report nothing found when an agent matches", () => {
      mockUseAgentOptions.mockReturnValue({
        data: [{ id: "agent-1", name: "Support Triage" }],
      });
      render(<ConversationSearchPalette {...defaultProps} />);

      fireEvent.change(screen.getByTestId("command-input"), {
        target: { value: "triage" },
      });

      expect(
        screen.queryByText("No chats or pages found."),
      ).not.toBeInTheDocument();
    });
  });

  it("routes Connect to the connection page", () => {
    // The Pages nav group (incl. Connect) renders when there are no conversations.
    mockUseConversations.mockReturnValue({
      data: [],
      isLoading: false,
      isFetching: false,
    });
    render(<ConversationSearchPalette {...defaultProps} />);

    fireEvent.click(screen.getByText("Connect"));

    expect(mockRouterPush).toHaveBeenCalledWith("/connection");
  });

  it("routes MCP Registry to the registry", () => {
    mockUseConversations.mockReturnValue({
      data: [],
      isLoading: false,
      isFetching: false,
    });
    render(<ConversationSearchPalette {...defaultProps} />);

    fireEvent.click(screen.getByText("MCP Registry"));

    expect(mockRouterPush).toHaveBeenCalledWith("/mcp/registry");
  });

  it.each([
    { enabled: true, permitted: true },
    { enabled: false, permitted: true },
    { enabled: true, permitted: false },
  ])("offers OpenAPPA Guardrails only when enabled and permitted: %j", ({
    enabled,
    permitted,
  }) => {
    vi.mocked(useFeature).mockImplementation(
      (feature) => feature === "openappaEnabled" && enabled,
    );
    vi.mocked(usePermissionMap).mockReturnValue({ "/openappa": permitted });
    mockUseConversations.mockReturnValue({
      data: [],
      isLoading: false,
      isFetching: false,
    });
    render(<ConversationSearchPalette {...defaultProps} />);
    fireEvent.change(screen.getByTestId("command-input"), {
      target: { value: "openappa" },
    });
    if (enabled && permitted) {
      fireEvent.click(screen.getByText("Guardrails"));
      expect(mockRouterPush).toHaveBeenCalledWith("/openappa");
    } else {
      expect(screen.queryByText("Guardrails")).not.toBeInTheDocument();
    }
  });

  it("searches pages by their visible labels and navigates to a match", () => {
    mockUseConversations.mockReturnValue({
      data: [],
      isLoading: false,
      isFetching: true,
    });
    render(<ConversationSearchPalette {...defaultProps} />);

    fireEvent.change(screen.getByTestId("command-input"), {
      target: { value: "registry" },
    });

    expect(screen.getByText("Pages")).toBeInTheDocument();
    expect(screen.getByText("MCP Registry")).toBeInTheDocument();
    expect(screen.queryByText("Agents")).not.toBeInTheDocument();

    fireEvent.click(screen.getByText("MCP Registry"));
    expect(mockRouterPush).toHaveBeenCalledWith("/mcp/registry");
  });

  it("searches pages by navigation keywords", () => {
    mockUseConversations.mockReturnValue({
      data: [],
      isLoading: false,
      isFetching: false,
    });
    render(<ConversationSearchPalette {...defaultProps} />);

    fireEvent.change(screen.getByTestId("command-input"), {
      target: { value: "catalog" },
    });

    expect(screen.getByText("MCP Registry")).toBeInTheDocument();
    expect(screen.queryByText("Agents")).not.toBeInTheDocument();
  });

  it("leaves out a page the reader may not open", () => {
    mockUseConversations.mockReturnValue({
      data: [],
      isLoading: false,
      isFetching: false,
    });
    vi.mocked(usePermissionMap).mockReturnValue(
      Object.fromEntries(
        Object.keys(requiredPagePermissionsMap).map((url) => [
          url,
          url !== "/mcp/registry",
        ]),
      ),
    );
    render(<ConversationSearchPalette {...defaultProps} />);

    // Its siblings are gated separately and stay, so this is the permission
    // check and not an empty list.
    expect(screen.getByText("MCP Gateways")).toBeInTheDocument();
    expect(screen.queryByText("MCP Registry")).not.toBeInTheDocument();
  });

  it.each([
    { role: "member", offered: false },
    { role: "editor", offered: true },
  ] as const)("offers Settings only to a reader who can see the Settings area: $role", ({
    role,
    offered,
  }) => {
    // Both of the hook's permission maps resolved from the role itself.
    vi.mocked(usePermissionMap).mockImplementation((map) =>
      Object.fromEntries(
        Object.entries(map).map(([key, required]) => [
          key,
          hasPagePermissions({
            userPermissions: predefinedPermissionsMap[role],
            required,
            capabilities: [],
          }),
        ]),
      ),
    );
    mockUseConversations.mockReturnValue({
      data: [],
      isLoading: false,
      isFetching: false,
    });
    render(<ConversationSearchPalette {...defaultProps} />);
    fireEvent.change(screen.getByTestId("command-input"), {
      target: { value: "settings" },
    });

    if (offered) {
      expect(screen.getByText("Settings")).toBeInTheDocument();
    } else {
      expect(screen.queryByText("Settings")).not.toBeInTheDocument();
    }
  });

  it("shows page matches alongside matching chats", () => {
    render(<ConversationSearchPalette {...defaultProps} />);

    fireEvent.change(screen.getByTestId("command-input"), {
      target: { value: "agent" },
    });

    expect(screen.getByText("Pages")).toBeInTheDocument();
    expect(screen.getByText("First conversation")).toBeInTheDocument();
    expect(screen.getByText("Second conversation")).toBeInTheDocument();
    expect(screen.getByText("Chats")).toBeInTheDocument();
  });

  it("reports an empty unified search only when no chat or page matches", () => {
    mockUseConversations.mockReturnValue({
      data: [],
      isLoading: false,
      isFetching: false,
    });
    render(<ConversationSearchPalette {...defaultProps} />);

    fireEvent.change(screen.getByTestId("command-input"), {
      target: { value: "nothing-matches-this" },
    });

    expect(screen.getByText("No chats or pages found.")).toBeInTheDocument();
  });

  it("does not show the recent chats empty state in the full search palette", () => {
    mockUseConversations.mockReturnValue({
      data: [],
      isLoading: false,
      isFetching: false,
    });

    render(<ConversationSearchPalette {...defaultProps} />);

    expect(screen.getByText("New chat")).toBeInTheDocument();
    expect(screen.getByText("Pages")).toBeInTheDocument();
  });

  describe("with more recent chats than fit before the pages", () => {
    beforeEach(() => {
      mockUseConversations.mockReturnValue({
        data: Array.from({ length: 8 }, (_, index) => ({
          id: `recent-${index}`,
          title: `Recent chat ${index}`,
          updatedAt: new Date(Date.now() - index * 60_000).toISOString(),
          lastMessageAt: new Date(Date.now() - index * 60_000).toISOString(),
          messages: [],
        })),
        isLoading: false,
        isFetching: false,
      });
    });

    it("lists the five newest and points to search for the rest", () => {
      render(<ConversationSearchPalette {...defaultProps} />);

      expect(screen.getByText("Recent chat 4")).toBeInTheDocument();
      expect(screen.queryByText("Recent chat 5")).not.toBeInTheDocument();
      expect(
        screen.getByText("Type to search older chats"),
      ).toBeInTheDocument();
      expect(screen.getByText("Pages")).toBeInTheDocument();
    });

    it("finds an older chat by typing", () => {
      render(<ConversationSearchPalette {...defaultProps} />);

      fireEvent.change(screen.getByTestId("command-input"), {
        target: { value: "Recent chat" },
      });

      expect(screen.getByText("Recent chat 7")).toBeInTheDocument();
    });
  });

  it("redirects to /chat when deleting the currently viewed conversation", () => {
    vi.mocked(usePathname).mockReturnValue("/chat/conv-1");

    render(<ConversationSearchPalette {...defaultProps} />);

    // Simulate selecting conv-1 via the captured onValueChange
    act(() => {
      capturedOnValueChange?.("conv-conv-1");
    });

    // Press 'd' once to enter pending deletion state
    fireEvent.keyDown(window, { key: "d", code: "KeyD", altKey: true });

    // Press 'd' again to confirm deletion
    fireEvent.keyDown(window, { key: "d", code: "KeyD", altKey: true });

    // Should have called deleteMutation.mutate with the conversation ID
    expect(mockDeleteMutate).toHaveBeenCalledWith(
      "conv-1",
      expect.objectContaining({ onSettled: expect.any(Function) }),
    );

    // Should redirect to /chat since the deleted conversation is currently open
    expect(mockRouterPush).toHaveBeenCalledWith("/chat");
  });

  it("does not redirect when deleting a conversation that is not currently viewed", () => {
    vi.mocked(usePathname).mockReturnValue("/chat/conv-2");

    render(<ConversationSearchPalette {...defaultProps} />);

    // Simulate selecting conv-1 via the captured onValueChange
    act(() => {
      capturedOnValueChange?.("conv-conv-1");
    });

    // Press 'd' once to enter pending deletion state
    fireEvent.keyDown(window, { key: "d", code: "KeyD", altKey: true });

    // Press 'd' again to confirm deletion
    fireEvent.keyDown(window, { key: "d", code: "KeyD", altKey: true });

    // Should have called deleteMutation.mutate
    expect(mockDeleteMutate).toHaveBeenCalledWith(
      "conv-1",
      expect.objectContaining({ onSettled: expect.any(Function) }),
    );

    // Should NOT redirect since the deleted conversation is not the one currently open
    expect(mockRouterPush).not.toHaveBeenCalled();
  });

  it("does not redirect when deleting a conversation and no conversation is open", () => {
    render(<ConversationSearchPalette {...defaultProps} />);

    // Simulate selecting conv-1
    act(() => {
      capturedOnValueChange?.("conv-conv-1");
    });

    // Press 'd' twice to delete
    fireEvent.keyDown(window, { key: "d", code: "KeyD", altKey: true });
    fireEvent.keyDown(window, { key: "d", code: "KeyD", altKey: true });

    expect(mockDeleteMutate).toHaveBeenCalledWith(
      "conv-1",
      expect.objectContaining({ onSettled: expect.any(Function) }),
    );
    expect(mockRouterPush).not.toHaveBeenCalled();
  });

  it("prevents rapid double-deletion of the same conversation", () => {
    render(<ConversationSearchPalette {...defaultProps} />);

    // Select conv-1
    act(() => {
      capturedOnValueChange?.("conv-conv-1");
    });

    // Press 'd' once → pending state
    fireEvent.keyDown(window, { key: "d", code: "KeyD", altKey: true });
    // Press 'd' again → confirms deletion
    fireEvent.keyDown(window, { key: "d", code: "KeyD", altKey: true });

    expect(mockDeleteMutate).toHaveBeenCalledTimes(1);

    // Rapid third 'd' press in the same frame — should be ignored
    // because the ref guard prevents double-deletion before React re-renders
    fireEvent.keyDown(window, { key: "d", code: "KeyD", altKey: true });

    expect(mockDeleteMutate).toHaveBeenCalledTimes(1);
  });

  it("ignores bare character keys — shortcuts require the Alt modifier", () => {
    render(<ConversationSearchPalette {...defaultProps} />);

    act(() => {
      capturedOnValueChange?.("conv-conv-1");
    });

    // Bare "d" (no modifier) must not trigger deletion (WCAG 2.1.4)
    fireEvent.keyDown(window, { key: "d", code: "KeyD" });
    fireEvent.keyDown(window, { key: "d", code: "KeyD" });

    expect(mockDeleteMutate).not.toHaveBeenCalled();
  });

  it("announces the delete confirmation prompt via a live region", () => {
    render(<ConversationSearchPalette {...defaultProps} />);

    act(() => {
      capturedOnValueChange?.("conv-conv-1");
    });

    fireEvent.keyDown(window, { key: "d", code: "KeyD", altKey: true });

    expect(screen.getByRole("status")).toHaveTextContent("again to confirm");
  });

  it("navigates to conversation when selecting it", () => {
    render(<ConversationSearchPalette {...defaultProps} />);

    // Click a conversation item
    fireEvent.click(screen.getByTestId("cmd-item-conv-conv-1"));

    expect(mockRouterPush).toHaveBeenCalledWith("/chat/conv-1");
  });

  it("reopens a policy conversation in chat", () => {
    mockUseConversations.mockReturnValue({
      data: [
        {
          id: "policy-1",
          title: "Review policy",
          origin: "user",
          updatedAt: new Date().toISOString(),
          lastMessageAt: new Date().toISOString(),
          messages: [],
        },
      ],
      isLoading: false,
      isFetching: false,
    });
    render(<ConversationSearchPalette {...defaultProps} />);
    fireEvent.click(screen.getByTestId("cmd-item-conv-policy-1"));
    expect(mockRouterPush).toHaveBeenCalledWith("/chat/policy-1");
  });

  it("navigates to /chat when selecting new chat", () => {
    render(<ConversationSearchPalette {...defaultProps} />);

    fireEvent.click(screen.getByTestId("cmd-item-new-chat"));

    expect(mockRouterPush).toHaveBeenCalledWith("/chat");
  });

  it("offers a new encrypted chat only when the feature is enabled", () => {
    const { rerender } = render(
      <ConversationSearchPalette {...defaultProps} />,
    );
    expect(screen.queryByText("New encrypted chat")).not.toBeInTheDocument();

    vi.mocked(useFeature).mockReturnValue(true);
    rerender(<ConversationSearchPalette {...defaultProps} />);

    fireEvent.click(screen.getByText("New encrypted chat"));
    expect(mockRouterPush).toHaveBeenCalledWith("/chat?encryptedChat=1");
  });

  it("shows the project a chat belongs to, like the sidebar does", () => {
    mockUseConversations.mockReturnValue({
      data: [
        {
          id: "conv-1",
          title: "First conversation",
          updatedAt: new Date().toISOString(),
          lastMessageAt: new Date().toISOString(),
          messages: [],
          projectId: "project-1",
          projectName: "Acme Redesign",
        },
      ],
      isLoading: false,
      isFetching: false,
    });

    render(<ConversationSearchPalette {...defaultProps} />);

    expect(screen.getByText("Acme Redesign")).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "Open project Acme Redesign" }),
    );
    expect(mockRouterPush).toHaveBeenCalledWith("/projects/project-1");
    expect(defaultProps.onOpenChange).toHaveBeenCalledWith(false);
    expect(mockRouterPush).not.toHaveBeenCalledWith("/chat/conv-1");
  });

  it("does not offer the removed Client Credentials destination", () => {
    render(<ConversationSearchPalette {...defaultProps} />);
    expect(
      screen.queryByRole("button", { name: "Client Credentials" }),
    ).not.toBeInTheDocument();
  });
});
