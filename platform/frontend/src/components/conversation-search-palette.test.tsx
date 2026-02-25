import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock ResizeObserver which is used by Radix UI components
global.ResizeObserver = vi.fn().mockImplementation(() => ({
  observe: vi.fn(),
  unobserve: vi.fn(),
  disconnect: vi.fn(),
}));

const mockRouterPush = vi.fn();
const mockSearchParamsGet = vi.fn();
const mockDeleteMutate = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockRouterPush }),
  useSearchParams: () => ({ get: mockSearchParamsGet }),
}));

vi.mock("@uidotdev/usehooks", () => ({
  useDebounce: (value: string) => value,
}));

vi.mock("@/hooks/use-platform", () => ({
  usePlatform: () => ({ modKey: "⌘", altKey: "⌥", isMac: true }),
}));

vi.mock("@/lib/auth.hook", () => ({
  useIsAuthenticated: () => true,
}));

vi.mock("@/lib/chat-utils", () => ({
  getConversationDisplayTitle: (title: string | null) =>
    title ?? "Untitled chat",
}));

vi.mock("@/lib/chat.query", () => ({
  useConversations: () => ({
    data: [
      {
        id: "conv-1",
        title: "First conversation",
        updatedAt: new Date().toISOString(),
        messages: [],
      },
      {
        id: "conv-2",
        title: "Second conversation",
        updatedAt: new Date().toISOString(),
        messages: [],
      },
    ],
    isLoading: false,
    isFetching: false,
  }),
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

// Import component after mocks
import { act } from "react";
import { ConversationSearchPalette } from "./conversation-search-palette";

describe("ConversationSearchPalette", () => {
  const defaultProps = {
    open: true,
    onOpenChange: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockSearchParamsGet.mockReturnValue(null);
    capturedOnValueChange = null;
  });

  it("renders conversations when open", () => {
    render(<ConversationSearchPalette {...defaultProps} />);

    expect(screen.getByText("First conversation")).toBeInTheDocument();
    expect(screen.getByText("Second conversation")).toBeInTheDocument();
  });

  it("redirects to /chat when deleting the currently viewed conversation", () => {
    // Simulate being on /chat?conversation=conv-1
    mockSearchParamsGet.mockImplementation((key: string) =>
      key === "conversation" ? "conv-1" : null,
    );

    render(<ConversationSearchPalette {...defaultProps} />);

    // Simulate selecting conv-1 via the captured onValueChange
    act(() => {
      capturedOnValueChange?.("conv-conv-1");
    });

    // Press 'd' once to enter pending deletion state
    fireEvent.keyDown(window, { key: "d", code: "KeyD" });

    // Press 'd' again to confirm deletion
    fireEvent.keyDown(window, { key: "d", code: "KeyD" });

    // Should have called deleteMutation.mutate with the conversation ID
    expect(mockDeleteMutate).toHaveBeenCalledWith("conv-1");

    // Should redirect to /chat since the deleted conversation is currently open
    expect(mockRouterPush).toHaveBeenCalledWith("/chat");
  });

  it("does not redirect when deleting a conversation that is not currently viewed", () => {
    // Simulate being on /chat?conversation=conv-2 (different from what we'll delete)
    mockSearchParamsGet.mockImplementation((key: string) =>
      key === "conversation" ? "conv-2" : null,
    );

    render(<ConversationSearchPalette {...defaultProps} />);

    // Simulate selecting conv-1 via the captured onValueChange
    act(() => {
      capturedOnValueChange?.("conv-conv-1");
    });

    // Press 'd' once to enter pending deletion state
    fireEvent.keyDown(window, { key: "d", code: "KeyD" });

    // Press 'd' again to confirm deletion
    fireEvent.keyDown(window, { key: "d", code: "KeyD" });

    // Should have called deleteMutation.mutate
    expect(mockDeleteMutate).toHaveBeenCalledWith("conv-1");

    // Should NOT redirect since the deleted conversation is not the one currently open
    expect(mockRouterPush).not.toHaveBeenCalled();
  });

  it("does not redirect when deleting a conversation and no conversation is open", () => {
    // Simulate being on /chat with no conversation param
    mockSearchParamsGet.mockReturnValue(null);

    render(<ConversationSearchPalette {...defaultProps} />);

    // Simulate selecting conv-1
    act(() => {
      capturedOnValueChange?.("conv-conv-1");
    });

    // Press 'd' twice to delete
    fireEvent.keyDown(window, { key: "d", code: "KeyD" });
    fireEvent.keyDown(window, { key: "d", code: "KeyD" });

    expect(mockDeleteMutate).toHaveBeenCalledWith("conv-1");
    expect(mockRouterPush).not.toHaveBeenCalled();
  });

  it("navigates to conversation when selecting it", () => {
    render(<ConversationSearchPalette {...defaultProps} />);

    // Click a conversation item
    fireEvent.click(screen.getByTestId("cmd-item-conv-conv-1"));

    expect(mockRouterPush).toHaveBeenCalledWith("/chat?conversation=conv-1");
  });

  it("navigates to /chat when selecting new chat", () => {
    render(<ConversationSearchPalette {...defaultProps} />);

    fireEvent.click(screen.getByTestId("cmd-item-new-chat"));

    expect(mockRouterPush).toHaveBeenCalledWith("/chat");
  });
});
