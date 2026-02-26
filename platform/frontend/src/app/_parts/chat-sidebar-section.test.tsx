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

vi.mock("@/lib/auth.hook", () => ({
  useIsAuthenticated: () => true,
}));

vi.mock("@/lib/auth.query", () => ({
  useHasPermissions: () => ({ data: true }),
}));

vi.mock("@/lib/chat-utils", () => ({
  getConversationDisplayTitle: (title: string | null) =>
    title ?? "Untitled chat",
}));

vi.mock("@/lib/chat.hook", () => ({
  useRecentlyGeneratedTitles: () => ({
    recentlyGeneratedTitles: new Set(),
    regeneratingTitles: new Set(),
    triggerRegeneration: vi.fn(),
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
}> = [];

vi.mock("@/lib/chat.query", () => ({
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
    mutateAsync: vi.fn(),
    isPending: false,
  }),
  usePinConversation: () => ({ mutate: vi.fn() }),
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

vi.mock("@/components/ui/alert-dialog", () => ({
  AlertDialog: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  AlertDialogContent: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
  AlertDialogHeader: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
  AlertDialogTitle: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
  AlertDialogDescription: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
  AlertDialogFooter: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
  AlertDialogCancel: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
  AlertDialogAction: ({ children }: { children: React.ReactNode }) => (
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
  beforeEach(() => {
    vi.clearAllMocks();
    mockConversations = [];
  });

  it("does not render when no conversations exist", () => {
    mockConversations = [];
    const { container } = render(<ChatSidebarSection />);
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

    render(<ChatSidebarSection />);

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

  it("shows only pinned chats when 3 are pinned (no recent unpinned)", () => {
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

    render(<ChatSidebarSection />);

    // All 3 pinned should show
    expect(screen.getByText("Pinned One")).toBeInTheDocument();
    expect(screen.getByText("Pinned Two")).toBeInTheDocument();
    expect(screen.getByText("Pinned Three")).toBeInTheDocument();

    // Unpinned should NOT show (all 3 slots taken by pinned)
    expect(screen.queryByText("Unpinned One")).not.toBeInTheDocument();

    // Should show "More" to open search
    expect(screen.getByText("More")).toBeInTheDocument();
  });

  it("fills remaining slots with recent chats when fewer than 3 are pinned", () => {
    mockConversations = [
      makeConv("c1", "Pinned Chat", {
        pinnedAt: "2026-01-05T00:00:00Z",
        updatedAt: "2026-01-05T00:00:00Z",
      }),
      makeConv("c2", "Recent One", { updatedAt: "2026-01-04T00:00:00Z" }),
      makeConv("c3", "Recent Two", { updatedAt: "2026-01-03T00:00:00Z" }),
      makeConv("c4", "Recent Three", { updatedAt: "2026-01-02T00:00:00Z" }),
    ];

    render(<ChatSidebarSection />);

    // 1 pinned + 2 recent = 3 total
    expect(screen.getByText("Pinned Chat")).toBeInTheDocument();
    expect(screen.getByText("Recent One")).toBeInTheDocument();
    expect(screen.getByText("Recent Two")).toBeInTheDocument();

    // 3rd recent should NOT show (only 2 remaining slots)
    expect(screen.queryByText("Recent Three")).not.toBeInTheDocument();

    // Should show "More" to open search
    expect(screen.getByText("More")).toBeInTheDocument();
  });

  it("shows 2 pinned + 1 recent when 2 are pinned", () => {
    mockConversations = [
      makeConv("c1", "Pinned A", {
        pinnedAt: "2026-01-05T00:00:00Z",
        updatedAt: "2026-01-05T00:00:00Z",
      }),
      makeConv("c2", "Pinned B", {
        pinnedAt: "2026-01-04T00:00:00Z",
        updatedAt: "2026-01-04T00:00:00Z",
      }),
      makeConv("c3", "Recent A", { updatedAt: "2026-01-03T00:00:00Z" }),
      makeConv("c4", "Recent B", { updatedAt: "2026-01-02T00:00:00Z" }),
    ];

    render(<ChatSidebarSection />);

    // 2 pinned + 1 recent = 3 total
    expect(screen.getByText("Pinned A")).toBeInTheDocument();
    expect(screen.getByText("Pinned B")).toBeInTheDocument();
    expect(screen.getByText("Recent A")).toBeInTheDocument();

    // 2nd recent should not show
    expect(screen.queryByText("Recent B")).not.toBeInTheDocument();
  });

  it("does not show 'More' when total conversations fit in slots", () => {
    mockConversations = [
      makeConv("c1", "Only Chat", { updatedAt: "2026-01-01T00:00:00Z" }),
    ];

    render(<ChatSidebarSection />);

    expect(screen.getByText("Only Chat")).toBeInTheDocument();
    expect(screen.queryByText("More")).not.toBeInTheDocument();
  });

  describe("stable order (prevents sidebar jumping)", () => {
    it("preserves chat order when updatedAt changes cause backend reordering", () => {
      mockConversations = [
        makeConv("c1", "Chat One", { updatedAt: "2026-01-05T00:00:00Z" }),
        makeConv("c2", "Chat Two", { updatedAt: "2026-01-04T00:00:00Z" }),
        makeConv("c3", "Chat Three", { updatedAt: "2026-01-03T00:00:00Z" }),
      ];

      const { rerender } = render(<ChatSidebarSection />);

      // Initial order
      const getOrder = () =>
        screen.getAllByRole("button").map((btn) => btn.textContent?.trim());
      const initialOrder = getOrder();

      // Simulate updatedAt bump moving "Chat Three" to front
      mockConversations = [
        makeConv("c3", "Chat Three", { updatedAt: "2026-01-06T00:00:00Z" }),
        makeConv("c1", "Chat One", { updatedAt: "2026-01-05T00:00:00Z" }),
        makeConv("c2", "Chat Two", { updatedAt: "2026-01-04T00:00:00Z" }),
      ];

      rerender(<ChatSidebarSection />);

      // Order should remain the same as initial render
      expect(getOrder()).toEqual(initialOrder);
    });

    it("prepends newly created conversations at the top", () => {
      mockConversations = [
        makeConv("c1", "Chat One", { updatedAt: "2026-01-05T00:00:00Z" }),
        makeConv("c2", "Chat Two", { updatedAt: "2026-01-04T00:00:00Z" }),
        makeConv("c3", "Chat Three", { updatedAt: "2026-01-03T00:00:00Z" }),
        makeConv("c4", "Chat Four", { updatedAt: "2026-01-02T00:00:00Z" }),
      ];

      const { rerender } = render(<ChatSidebarSection />);

      // Initial: shows c1, c2, c3 (3 slots)
      expect(screen.getByText("Chat One")).toBeInTheDocument();
      expect(screen.getByText("Chat Two")).toBeInTheDocument();
      expect(screen.getByText("Chat Three")).toBeInTheDocument();

      // New conversation created (appears first from backend)
      mockConversations = [
        makeConv("c-new", "New Chat", { updatedAt: "2026-01-10T00:00:00Z" }),
        makeConv("c1", "Chat One", { updatedAt: "2026-01-05T00:00:00Z" }),
        makeConv("c2", "Chat Two", { updatedAt: "2026-01-04T00:00:00Z" }),
        makeConv("c3", "Chat Three", { updatedAt: "2026-01-03T00:00:00Z" }),
        makeConv("c4", "Chat Four", { updatedAt: "2026-01-02T00:00:00Z" }),
      ];

      rerender(<ChatSidebarSection />);

      // New chat should be at the top
      expect(screen.getByText("New Chat")).toBeInTheDocument();
    });

    it("removes deleted conversations from the stable order", () => {
      mockConversations = [
        makeConv("c1", "Chat One", { updatedAt: "2026-01-05T00:00:00Z" }),
        makeConv("c2", "Chat Two", { updatedAt: "2026-01-04T00:00:00Z" }),
        makeConv("c3", "Chat Three", { updatedAt: "2026-01-03T00:00:00Z" }),
      ];

      const { rerender } = render(<ChatSidebarSection />);

      expect(screen.getByText("Chat Two")).toBeInTheDocument();

      // "Chat Two" deleted
      mockConversations = [
        makeConv("c1", "Chat One", { updatedAt: "2026-01-05T00:00:00Z" }),
        makeConv("c3", "Chat Three", { updatedAt: "2026-01-03T00:00:00Z" }),
      ];

      rerender(<ChatSidebarSection />);

      expect(screen.queryByText("Chat Two")).not.toBeInTheDocument();
      expect(screen.getByText("Chat One")).toBeInTheDocument();
      expect(screen.getByText("Chat Three")).toBeInTheDocument();
    });

    it("preserves pinned chat order when updatedAt changes cause backend reordering", () => {
      // All 3 slots taken by pinned chats
      mockConversations = [
        makeConv("p1", "Pinned Alpha", {
          pinnedAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-05T00:00:00Z",
        }),
        makeConv("p2", "Pinned Beta", {
          pinnedAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-04T00:00:00Z",
        }),
        makeConv("p3", "Pinned Gamma", {
          pinnedAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-03T00:00:00Z",
        }),
        makeConv("c4", "Unpinned One", { updatedAt: "2026-01-02T00:00:00Z" }),
      ];

      const { rerender } = render(<ChatSidebarSection />);

      const getOrder = () =>
        screen.getAllByRole("button").map((btn) => btn.textContent?.trim());
      const initialOrder = getOrder();

      // Simulate updatedAt bump on "Pinned Gamma" — backend returns it first now
      mockConversations = [
        makeConv("p3", "Pinned Gamma", {
          pinnedAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-10T00:00:00Z",
        }),
        makeConv("p1", "Pinned Alpha", {
          pinnedAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-05T00:00:00Z",
        }),
        makeConv("p2", "Pinned Beta", {
          pinnedAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-04T00:00:00Z",
        }),
        makeConv("c4", "Unpinned One", { updatedAt: "2026-01-02T00:00:00Z" }),
      ];

      rerender(<ChatSidebarSection />);

      // Pinned order should remain frozen
      expect(getOrder()).toEqual(initialOrder);
    });

    it("preserves mixed pinned/unpinned order when updatedAt changes", () => {
      mockConversations = [
        makeConv("p1", "Pinned Chat", {
          pinnedAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-05T00:00:00Z",
        }),
        makeConv("c1", "Recent One", { updatedAt: "2026-01-04T00:00:00Z" }),
        makeConv("c2", "Recent Two", { updatedAt: "2026-01-03T00:00:00Z" }),
        makeConv("c3", "Recent Three", { updatedAt: "2026-01-02T00:00:00Z" }),
      ];

      const { rerender } = render(<ChatSidebarSection />);

      const getOrder = () =>
        screen.getAllByRole("button").map((btn) => btn.textContent?.trim());
      const initialOrder = getOrder();

      // "Recent Two" gets updatedAt bumped, backend moves it to front
      mockConversations = [
        makeConv("c2", "Recent Two", { updatedAt: "2026-01-10T00:00:00Z" }),
        makeConv("p1", "Pinned Chat", {
          pinnedAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-05T00:00:00Z",
        }),
        makeConv("c1", "Recent One", { updatedAt: "2026-01-04T00:00:00Z" }),
        makeConv("c3", "Recent Three", { updatedAt: "2026-01-02T00:00:00Z" }),
      ];

      rerender(<ChatSidebarSection />);

      // Order should remain frozen for both pinned and unpinned
      expect(getOrder()).toEqual(initialOrder);
    });
  });
});
