import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock ResizeObserver used by Radix UI components
global.ResizeObserver = vi.fn().mockImplementation(() => ({
  observe: vi.fn(),
  unobserve: vi.fn(),
  disconnect: vi.fn(),
}));

const mockRouterPush = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockRouterPush }),
  usePathname: () => "/chat",
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
  getConversationDisplayTitle: (title: string | null, messages?: unknown[]) => {
    if (title) return title;
    const firstUserMessage = messages?.find((message) => {
      return (
        typeof message === "object" &&
        message !== null &&
        "role" in message &&
        message.role === "user"
      );
    }) as { parts?: Array<{ type?: string; text?: string }> } | undefined;
    return (
      firstUserMessage?.parts?.find((part) => part.type === "text")?.text ??
      "New Chat Session"
    );
  },
}));

vi.mock("@/lib/chat/global-chat.context", () => ({
  useGlobalChat: () => ({
    animatingTitleIds: new Set(),
    markTitleAnimating: vi.fn(),
  }),
}));

// Mocked conversation data - will be set per test
let mockConversations: Array<{
  id: string;
  title: string | null;
  pinnedAt: string | null;
  projectId: string | null;
  updatedAt: string;
  messages: unknown[];
  agent: { id: string; name: string };
}> = [];

let mockProjects: Array<{
  id: string;
  name: string;
  icon: string | null;
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

vi.mock("@/lib/project.query", () => ({
  useProjects: () => ({
    data: { data: mockProjects, pagination: { total: mockProjects.length } },
    isLoading: false,
  }),
}));

vi.mock("@/components/agent-icon", () => ({
  AgentIcon: ({ icon }: { icon: string | null }) => (
    <span>{icon ?? "project"}</span>
  ),
}));

// Minimal sidebar UI mock - render children directly
vi.mock("@/components/ui/sidebar", () => ({
  useSidebar: () => ({ isMobile: false, setOpenMobile: vi.fn() }),
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
  SidebarMenuItem: ({ children }: { children: React.ReactNode }) => (
    <li>{children}</li>
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
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
  DropdownMenuItem: () => null,
  DropdownMenuLabel: ({ children }: { children: React.ReactNode }) => (
    <span>{children}</span>
  ),
  DropdownMenuRadioGroup: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
  DropdownMenuRadioItem: ({ children }: { children: React.ReactNode }) => (
    <span>{children}</span>
  ),
  DropdownMenuTrigger: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
  DropdownMenuSeparator: () => null,
  DropdownMenuSub: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
  DropdownMenuSubContent: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
  DropdownMenuSubTrigger: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
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

// Import after mocks
import { ChatSidebarSection } from "./chat-sidebar-section";

function makeConv(
  id: string,
  title: string,
  opts?: {
    messages?: unknown[];
    pinnedAt?: string;
    projectId?: string | null;
    updatedAt?: string;
  },
) {
  return {
    id,
    title: title || null,
    pinnedAt: opts?.pinnedAt ?? null,
    projectId: opts?.projectId ?? null,
    updatedAt: opts?.updatedAt ?? new Date().toISOString(),
    messages: opts?.messages ?? [],
    agent: { id: "agent-1", name: "Test Agent" },
  };
}

describe("ChatSidebarSection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConversations = [];
    mockProjects = [];
  });

  it("does not render when no conversations or projects exist", () => {
    mockConversations = [];
    const { container } = render(<ChatSidebarSection />);
    expect(container.innerHTML).toBe("");
  });

  it("groups project chats and uncategorized chats separately", () => {
    mockProjects = [
      { id: "project-1", name: "Customer Support", icon: "💬" },
      { id: "project-2", name: "Launch Plan", icon: "🚀" },
    ];
    mockConversations = [
      makeConv("c1", "Refund policy reply", { projectId: "project-1" }),
      makeConv("c2", "Launch checklist", { projectId: "project-2" }),
      makeConv("c3", "Unplanned question"),
    ];

    render(<ChatSidebarSection />);

    expect(screen.getByText("Customer Support")).toBeInTheDocument();
    expect(screen.getByText("Refund policy reply")).toBeInTheDocument();
    expect(screen.getByText("Launch Plan")).toBeInTheDocument();
    expect(screen.getByText("Launch checklist")).toBeInTheDocument();
    expect(screen.getByText("Other")).toBeInTheDocument();
    expect(screen.getByText("Unplanned question")).toBeInTheDocument();
  });

  it("does not clip visible conversations to three items", () => {
    mockConversations = [
      makeConv("c1", "Chat One"),
      makeConv("c2", "Chat Two"),
      makeConv("c3", "Chat Three"),
      makeConv("c4", "Chat Four"),
    ];

    render(<ChatSidebarSection />);

    expect(screen.getByText("Chat One")).toBeInTheDocument();
    expect(screen.getByText("Chat Two")).toBeInTheDocument();
    expect(screen.getByText("Chat Three")).toBeInTheDocument();
    expect(screen.getByText("Chat Four")).toBeInTheDocument();
    expect(screen.getByText("View all")).toBeInTheDocument();
  });

  it("shows pinned conversations before grouped conversations", () => {
    mockProjects = [{ id: "project-1", name: "Project One", icon: null }];
    mockConversations = [
      makeConv("c1", "Project chat", { projectId: "project-1" }),
      makeConv("c2", "Pinned chat", {
        pinnedAt: "2026-01-01T00:00:00Z",
        projectId: "project-1",
      }),
    ];

    render(<ChatSidebarSection />);

    const pinnedHeading = screen.getByText("Pinned");
    const pinnedChat = screen.getByText("Pinned chat");
    const projectHeading = screen.getByText("Project One");
    const projectChat = screen.getByText("Project chat");

    expect(pinnedHeading.compareDocumentPosition(projectHeading)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(pinnedChat).toBeInTheDocument();
    expect(projectChat).toBeInTheDocument();
  });

  it("falls back to the first user message while generated title is missing", () => {
    mockConversations = [
      makeConv("c1", "", {
        messages: [
          {
            role: "user",
            parts: [{ type: "text", text: "How is Montreal weather today?" }],
          },
        ],
      }),
    ];

    render(<ChatSidebarSection />);

    expect(
      screen.getByText("How is Montreal weather today?"),
    ).toBeInTheDocument();
    expect(screen.queryByText("New Chat Session")).not.toBeInTheDocument();
  });

  it("renders project controls even when only projects exist", () => {
    mockProjects = [{ id: "project-1", name: "Empty Project", icon: null }];

    render(<ChatSidebarSection />);

    expect(screen.getByText("Group by")).toBeInTheDocument();
    expect(screen.getByText("Empty Project")).toBeInTheDocument();
    expect(screen.getByText("No chats yet")).toBeInTheDocument();
  });
});
