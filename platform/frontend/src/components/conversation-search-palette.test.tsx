import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock ResizeObserver which is used by Radix UI components
global.ResizeObserver = vi.fn().mockImplementation(() => ({
  observe: vi.fn(),
  unobserve: vi.fn(),
  disconnect: vi.fn(),
}));

const { mockRouterPush, mockDeleteMutate, mockUseConversations } = vi.hoisted(
  () => ({
    mockRouterPush: vi.fn(),
    mockDeleteMutate: vi.fn(),
    mockUseConversations: vi.fn(),
  }),
);

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
    <button type="button" data-testid={`cmd-item-${value}`} onClick={onSelect}>
      {children}
    </button>
  ),
  CommandSeparator: () => <hr />,
}));

vi.mock("@/components/ui/badge", () => ({
  Badge: ({ children }: { children: React.ReactNode }) => (
    <span>{children}</span>
  ),
}));

import { requiredPagePermissionsMap } from "@archestra/shared/access-control";
import { usePathname, useRouter } from "next/navigation";
// Import component after mocks
import { act } from "react";
import { useHasPermissions, usePermissionMap } from "@/lib/auth/auth.query";
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

  it("shows page matches alongside matching chats", () => {
    render(<ConversationSearchPalette {...defaultProps} />);

    fireEvent.change(screen.getByTestId("command-input"), {
      target: { value: "agent" },
    });

    expect(screen.getByText("Agents")).toBeInTheDocument();
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
    expect(screen.queryByText("No recent chats")).not.toBeInTheDocument();
  });

  it("shows the recent chats empty state in recent chats view", () => {
    mockUseConversations.mockReturnValue({
      data: [],
      isLoading: false,
      isFetching: false,
    });

    render(<ConversationSearchPalette {...defaultProps} recentChatsView />);

    expect(screen.getByText("No recent chats")).toBeInTheDocument();
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

  it("navigates to /chat when selecting new chat", () => {
    render(<ConversationSearchPalette {...defaultProps} />);

    fireEvent.click(screen.getByTestId("cmd-item-new-chat"));

    expect(mockRouterPush).toHaveBeenCalledWith("/chat");
  });

  it("offers a new locked chat only when the feature is enabled", () => {
    const { rerender } = render(
      <ConversationSearchPalette {...defaultProps} />,
    );
    expect(screen.queryByText("New locked chat")).not.toBeInTheDocument();

    vi.mocked(useFeature).mockReturnValue(true);
    rerender(<ConversationSearchPalette {...defaultProps} />);

    fireEvent.click(screen.getByText("New locked chat"));
    expect(mockRouterPush).toHaveBeenCalledWith("/chat?lockedChat=1");
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
          projectName: "Acme Redesign",
        },
      ],
      isLoading: false,
      isFetching: false,
    });

    render(<ConversationSearchPalette {...defaultProps} />);

    expect(screen.getByText("Acme Redesign")).toBeInTheDocument();
  });

  it("does not offer the removed Client Credentials destination", () => {
    render(<ConversationSearchPalette {...defaultProps} />);
    expect(
      screen.queryByRole("button", { name: "Client Credentials" }),
    ).not.toBeInTheDocument();
  });
});
