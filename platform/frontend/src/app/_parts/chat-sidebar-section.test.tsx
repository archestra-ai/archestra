import {
  getChatItemGeneratingIndicatorTestId,
  getChatItemUnreadIndicatorTestId,
} from "@archestra/shared";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock ResizeObserver used by Radix UI components
global.ResizeObserver = vi.fn().mockImplementation(() => ({
  observe: vi.fn(),
  unobserve: vi.fn(),
  disconnect: vi.fn(),
}));

const mockRouterPush = vi.fn();

// Mutable holder so the status-indicator matrix can vary the viewed route, the
// per-conversation session status, and the unread set per test (object props
// stay reassignable without tripping the prefer-const lint).
const mockChatState: {
  pathname: string;
  sessionStatusById: Record<string, string>;
} = {
  pathname: "/chat",
  sessionStatusById: {},
};

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockRouterPush }),
  usePathname: () => mockChatState.pathname,
  useSearchParams: () => ({
    get: () => null,
  }),
}));

vi.mock("@/lib/auth/auth.hook", () => ({
  useIsAuthenticated: () => true,
}));

vi.mock("@/lib/auth/auth.query", () => ({
  useHasPermissions: () => ({ data: true }),
}));

vi.mock("@/lib/chat/chat-utils", () => ({
  getConversationDisplayTitle: (title: string | null) =>
    title ?? "Untitled chat",
}));

vi.mock("@/lib/chat/global-chat.context", () => ({
  useGlobalChat: () => ({
    animatingTitleIds: new Set(),
    markTitleAnimating: vi.fn(),
    getSession: (id: string) =>
      mockChatState.sessionStatusById[id]
        ? { status: mockChatState.sessionStatusById[id] }
        : undefined,
  }),
}));

// Mocked conversation data - will be set per test
let mockConversations: Array<{
  id: string;
  title: string | null;
  pinnedAt: string | null;
  updatedAt: string;
  messages: unknown[];
  agent: { id: string; name: string };
  projectName?: string | null;
  projectIcon?: string | null;
  unread?: boolean;
}> = [];

let mockProjects: Array<{
  id: string;
  name: string;
  icon: string | null;
  pinnedAt: string | null;
}> = [];

vi.mock("@/lib/chat/chat.query", () => ({
  useConversations: () => ({
    data: mockConversations,
    isLoading: false,
  }),
  useUpdateConversation: () => ({ mutateAsync: vi.fn() }),
  useDeleteConversation: () => ({
    mutateAsync: vi.fn(),
    isPending: false,
  }),
  useGenerateConversationTitle: () => ({
    mutate: vi.fn(),
    isPending: false,
    variables: undefined,
  }),
  usePinConversation: () => ({ mutate: vi.fn() }),
}));

vi.mock("@/lib/config/config.query", () => ({
  useFeature: () => true,
}));

vi.mock("@/lib/projects/projects.query", () => ({
  useProjects: () => ({ data: mockProjects }),
  usePinProject: () => ({ mutate: vi.fn() }),
  useCreateProjectFromConversation: () => ({
    mutateAsync: vi.fn(),
    isPending: false,
  }),
}));

vi.mock("@/components/agent-icon", () => ({
  AgentIcon: ({ icon }: { icon?: string | null }) => (
    <span data-testid="project-emoji">{icon}</span>
  ),
}));

// Minimal sidebar UI mock - render children directly
vi.mock("@/components/ui/sidebar", () => ({
  useSidebar: () => ({ isMobile: false, setOpenMobile: vi.fn() }),
  SidebarGroup: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  SidebarGroupLabel: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  SidebarGroupContent: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  SidebarMenu: ({ children }: { children: React.ReactNode }) => (
    <ul>{children}</ul>
  ),
  SidebarMenuItem: ({ children }: { children: React.ReactNode }) => (
    <li>{children}</li>
  ),
  SidebarMenuButton: ({
    children,
    onClick,
  }: {
    children: React.ReactNode;
    onClick?: () => void;
    isActive?: boolean;
    className?: string;
  }) => (
    <button type="button" onClick={onClick}>
      {children}
    </button>
  ),
  SidebarMenuSub: ({
    children,
  }: {
    children: React.ReactNode;
    className?: string;
  }) => <ul>{children}</ul>,
  SidebarMenuSubItem: ({ children }: { children: React.ReactNode }) => (
    <li>{children}</li>
  ),
  SidebarMenuSubButton: ({
    children,
    onClick,
  }: {
    children: React.ReactNode;
    onClick?: () => void;
    className?: string;
  }) => (
    <button type="button" onClick={onClick}>
      {children}
    </button>
  ),
}));

vi.mock("@/components/ui/tooltip", () => ({
  TooltipProvider: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
  TooltipContent: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
}));

vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
  DropdownMenuContent: () => null,
  DropdownMenuItem: () => null,
  DropdownMenuTrigger: () => null,
}));

vi.mock("@/components/ui/input", () => ({
  Input: () => <input />,
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({
    children,
    onClick,
  }: {
    children: React.ReactNode;
    onClick?: () => void;
  }) => (
    <button type="button" onClick={onClick}>
      {children}
    </button>
  ),
}));

vi.mock("@/components/ui/typing-text", () => ({
  TypingText: ({ text }: { text: string }) => <span>{text}</span>,
}));

vi.mock("@/components/truncated-text", () => ({
  TruncatedText: ({ message }: { message: string }) => <span>{message}</span>,
}));

vi.mock("@/lib/utils", () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(" "),
}));

vi.mock("lucide-react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("lucide-react")>();
  return {
    ...actual,
    Folder: (props: React.SVGProps<SVGSVGElement>) => (
      <svg aria-label="projects icon" {...props} />
    ),
  };
});

// Import after mocks
import { ChatSidebarSection } from "./chat-sidebar-section";

function makeConv(
  id: string,
  title: string,
  opts?: { pinnedAt?: string; updatedAt?: string },
) {
  return {
    id,
    title,
    pinnedAt: opts?.pinnedAt ?? null,
    updatedAt: opts?.updatedAt ?? new Date().toISOString(),
    messages: [],
    agent: { id: "agent-1", name: "Test Agent" },
  };
}

describe("ChatSidebarSection", () => {
  const fadeIn = {
    pending: () => true,
    done: () => {},
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockConversations = [];
    mockProjects = [];
    mockChatState.pathname = "/chat";
    mockChatState.sessionStatusById = {};
  });

  it("does not render when no conversations exist", () => {
    mockConversations = [];
    const { container } = render(<ChatSidebarSection fadeIn={fadeIn} />);
    expect(container.innerHTML).toBe("");
  });

  it("shows 3 recent chats when no chats are pinned", () => {
    mockConversations = [
      makeConv("c1", "Chat One", { updatedAt: "2026-01-05T00:00:00Z" }),
      makeConv("c2", "Chat Two", { updatedAt: "2026-01-04T00:00:00Z" }),
      makeConv("c3", "Chat Three", { updatedAt: "2026-01-03T00:00:00Z" }),
      makeConv("c4", "Chat Four", { updatedAt: "2026-01-02T00:00:00Z" }),
      makeConv("c5", "Chat Five", { updatedAt: "2026-01-01T00:00:00Z" }),
    ];

    render(<ChatSidebarSection fadeIn={fadeIn} />);

    // Should show first 3 recent (conversations come pre-sorted from API)
    expect(screen.getByText("Chat One")).toBeInTheDocument();
    expect(screen.getByText("Chat Two")).toBeInTheDocument();
    expect(screen.getByText("Chat Three")).toBeInTheDocument();

    // Should NOT show the 4th and 5th
    expect(screen.queryByText("Chat Four")).not.toBeInTheDocument();
    expect(screen.queryByText("Chat Five")).not.toBeInTheDocument();

    // Should show "More" to open search
    expect(screen.getByText("More")).toBeInTheDocument();
  });

  it("shows pinned and recents in separate sections", () => {
    mockConversations = [
      makeConv("c1", "Pinned One", {
        pinnedAt: "2026-01-05T00:00:00Z",
        updatedAt: "2026-01-05T00:00:00Z",
      }),
      makeConv("c2", "Pinned Two", {
        pinnedAt: "2026-01-04T00:00:00Z",
        updatedAt: "2026-01-04T00:00:00Z",
      }),
      makeConv("c3", "Pinned Three", {
        pinnedAt: "2026-01-03T00:00:00Z",
        updatedAt: "2026-01-03T00:00:00Z",
      }),
      makeConv("c4", "Unpinned One", { updatedAt: "2026-01-02T00:00:00Z" }),
    ];

    render(<ChatSidebarSection fadeIn={fadeIn} />);

    // Section labels
    expect(screen.getByText("Pinned")).toBeInTheDocument();
    expect(screen.getByText("Recents")).toBeInTheDocument();

    // Pinned chats are not capped by the recents budget — all 3 show...
    expect(screen.getByText("Pinned One")).toBeInTheDocument();
    expect(screen.getByText("Pinned Two")).toBeInTheDocument();
    expect(screen.getByText("Pinned Three")).toBeInTheDocument();

    // ...and the unpinned chat still shows under Recents.
    expect(screen.getByText("Unpinned One")).toBeInTheDocument();

    // Only 1 unpinned recent, so no "More".
    expect(screen.queryByText("More")).not.toBeInTheDocument();
  });

  it("shows all recents when within the slot budget", () => {
    mockConversations = [
      makeConv("c1", "Pinned Chat", {
        pinnedAt: "2026-01-05T00:00:00Z",
        updatedAt: "2026-01-05T00:00:00Z",
      }),
      makeConv("c2", "Recent One", { updatedAt: "2026-01-04T00:00:00Z" }),
      makeConv("c3", "Recent Two", { updatedAt: "2026-01-03T00:00:00Z" }),
      makeConv("c4", "Recent Three", { updatedAt: "2026-01-02T00:00:00Z" }),
    ];

    render(<ChatSidebarSection fadeIn={fadeIn} />);

    // Pinned shows in its own section; all 3 recents fit the slot budget.
    expect(screen.getByText("Pinned Chat")).toBeInTheDocument();
    expect(screen.getByText("Recent One")).toBeInTheDocument();
    expect(screen.getByText("Recent Two")).toBeInTheDocument();
    expect(screen.getByText("Recent Three")).toBeInTheDocument();

    // 3 unpinned == slots, so no "More".
    expect(screen.queryByText("More")).not.toBeInTheDocument();
  });

  it("does not render a Recents section or 'More' when all chats are pinned", () => {
    mockConversations = [
      makeConv("c1", "Pinned A", {
        pinnedAt: "2026-01-05T00:00:00Z",
        updatedAt: "2026-01-05T00:00:00Z",
      }),
      makeConv("c2", "Pinned B", {
        pinnedAt: "2026-01-04T00:00:00Z",
        updatedAt: "2026-01-04T00:00:00Z",
      }),
    ];

    render(<ChatSidebarSection fadeIn={fadeIn} />);

    expect(screen.getByText("Pinned")).toBeInTheDocument();
    expect(screen.getByText("Pinned A")).toBeInTheDocument();
    expect(screen.getByText("Pinned B")).toBeInTheDocument();

    // No unpinned chats → no Recents section and no dangling "More".
    expect(screen.queryByText("Recents")).not.toBeInTheDocument();
    expect(screen.queryByText("More")).not.toBeInTheDocument();
  });

  it("does not show 'More' when total conversations fit in slots", () => {
    mockConversations = [
      makeConv("c1", "Only Chat", { updatedAt: "2026-01-01T00:00:00Z" }),
    ];

    render(<ChatSidebarSection fadeIn={fadeIn} />);

    expect(screen.getByText("Only Chat")).toBeInTheDocument();
    expect(screen.queryByText("More")).not.toBeInTheDocument();
  });

  it("shows a pinned project's emoji and name when an emoji is present", () => {
    mockProjects = [
      {
        id: "project-1",
        name: "Generic Project",
        icon: "📌",
        pinnedAt: "2026-01-05T00:00:00Z",
      },
    ];

    render(<ChatSidebarSection fadeIn={fadeIn} />);

    expect(screen.getByText("Generic Project")).toBeInTheDocument();
    expect(screen.queryByLabelText("projects icon")).not.toBeInTheDocument();
    expect(screen.getByTestId("project-emoji")).toHaveTextContent("📌");
  });

  it("shows the project folder icon and name when no emoji is set", () => {
    mockProjects = [
      {
        id: "project-1",
        name: "Generic Project",
        icon: null,
        pinnedAt: "2026-01-05T00:00:00Z",
      },
    ];

    render(<ChatSidebarSection fadeIn={fadeIn} />);

    expect(screen.getByText("Generic Project")).toBeInTheDocument();
    expect(screen.getByLabelText("projects icon")).toBeInTheDocument();
    expect(screen.queryByTestId("project-emoji")).not.toBeInTheDocument();
  });

  it("shows a chat's project emoji and name when its project has an emoji", () => {
    mockConversations = [
      {
        ...makeConv("c1", "Project Chat"),
        projectName: "Generic Project",
        projectIcon: "📌",
      },
    ];

    render(<ChatSidebarSection fadeIn={fadeIn} />);

    expect(screen.getByText("Project Chat")).toBeInTheDocument();
    expect(screen.getByText("Generic Project")).toBeInTheDocument();
    expect(screen.queryByLabelText("projects icon")).not.toBeInTheDocument();
    expect(screen.getByTestId("project-emoji")).toHaveTextContent("📌");
  });

  it("shows a chat's project folder icon and name when the project has no emoji", () => {
    mockConversations = [
      {
        ...makeConv("c1", "Project Chat"),
        projectName: "Generic Project",
        projectIcon: null,
      },
    ];

    render(<ChatSidebarSection fadeIn={fadeIn} />);

    expect(screen.getByText("Project Chat")).toBeInTheDocument();
    expect(screen.getByText("Generic Project")).toBeInTheDocument();
    expect(screen.getByLabelText("projects icon")).toBeInTheDocument();
    expect(screen.queryByTestId("project-emoji")).not.toBeInTheDocument();
  });
});

// Coverage matrix for the sidebar status indicators across every
// (session status x viewed-or-not x unread) combination. The spinner shows
// while a chat generates (even one you're viewing); the new-messages dot shows
// on a backgrounded chat with unseen output, but never while generating (the
// spinner wins) and never on the chat you're currently viewing.
describe("ChatSidebarSection status indicators", () => {
  const fadeIn = { pending: () => true, done: () => {} };

  beforeEach(() => {
    vi.clearAllMocks();
    mockConversations = [];
    mockProjects = [];
    mockChatState.pathname = "/chat";
    mockChatState.sessionStatusById = {};
  });

  const cases: Array<{
    name: string;
    status?: string;
    current: boolean;
    unread: boolean;
    expectGenerating: boolean;
    expectUnread: boolean;
  }> = [
    {
      name: "idle, elsewhere, read",
      current: false,
      unread: false,
      expectGenerating: false,
      expectUnread: false,
    },
    {
      name: "streaming, elsewhere",
      status: "streaming",
      current: false,
      unread: false,
      expectGenerating: true,
      expectUnread: false,
    },
    {
      name: "submitted, elsewhere",
      status: "submitted",
      current: false,
      unread: false,
      expectGenerating: true,
      expectUnread: false,
    },
    {
      name: "streaming while viewing it",
      status: "streaming",
      current: true,
      unread: false,
      expectGenerating: true,
      expectUnread: false,
    },
    {
      name: "ready, elsewhere, unread",
      status: "ready",
      current: false,
      unread: true,
      expectGenerating: false,
      expectUnread: true,
    },
    {
      name: "generating wins over unread",
      status: "streaming",
      current: false,
      unread: true,
      expectGenerating: true,
      expectUnread: false,
    },
    {
      name: "unread suppressed on the viewed chat",
      status: "ready",
      current: true,
      unread: true,
      expectGenerating: false,
      expectUnread: false,
    },
  ];

  for (const {
    name,
    status,
    current,
    unread,
    expectGenerating,
    expectUnread,
  } of cases) {
    it(`renders the right indicator: ${name}`, () => {
      // `unread` is a server-derived field on the conversation row.
      mockConversations = [{ ...makeConv("c1", "Chat One"), unread }];
      mockChatState.pathname = current ? "/chat/c1" : "/chat";
      mockChatState.sessionStatusById = status ? { c1: status } : {};

      render(<ChatSidebarSection fadeIn={fadeIn} />);

      // Sanity: the row itself still renders (guards unrelated regressions).
      expect(screen.getByText("Chat One")).toBeInTheDocument();

      const generating = screen.queryByTestId(
        getChatItemGeneratingIndicatorTestId("c1"),
      );
      const unreadDot = screen.queryByTestId(
        getChatItemUnreadIndicatorTestId("c1"),
      );

      if (expectGenerating) {
        expect(generating).toBeInTheDocument();
      } else {
        expect(generating).not.toBeInTheDocument();
      }
      if (expectUnread) {
        expect(unreadDot).toBeInTheDocument();
      } else {
        expect(unreadDot).not.toBeInTheDocument();
      }
    });
  }
});
