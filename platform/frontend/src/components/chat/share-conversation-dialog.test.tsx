import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ShareConversationDialog } from "./share-conversation-dialog";

const mockShareMutateAsync = vi.fn();
const mockUnshareMutateAsync = vi.fn();
const { mockToastSuccess } = vi.hoisted(() => ({
  mockToastSuccess: vi.fn(),
}));
const mockUseConversationShare = vi.fn<
  () => {
    data: {
      id: string;
      visibility: "organization" | "team" | "user";
      teamIds: string[];
      userIds: string[];
    } | null;
    isLoading: boolean;
  }
>(() => ({
  data: null,
  isLoading: false,
}));

vi.mock("@/lib/chat/chat-share.query", () => ({
  useConversationShare: () => mockUseConversationShare(),
  useShareConversation: vi.fn(() => ({
    mutateAsync: mockShareMutateAsync,
    isPending: false,
  })),
  useUnshareConversation: vi.fn(() => ({
    mutateAsync: mockUnshareMutateAsync,
    isPending: false,
  })),
}));

vi.mock("sonner", () => ({
  toast: {
    success: mockToastSuccess,
  },
}));

vi.mock("@/lib/auth/auth.query", () => ({
  useSession: vi.fn(() => ({
    data: {
      user: {
        id: "current-user-id",
      },
    },
  })),
}));

vi.mock("@/lib/teams/team.query", () => ({
  useTeams: vi.fn(() => ({
    data: [{ id: "team-1", name: "Engineering" }],
  })),
}));

vi.mock("@/lib/organization.query", () => ({
  useOrganizationMembers: vi.fn(() => ({
    data: [{ id: "user-1", name: "Taylor", email: "taylor@example.com" }],
  })),
}));

vi.mock("@/components/ui/assignment-combobox", () => ({
  AssignmentCombobox: ({
    items,
    selectedIds,
    onToggle,
  }: {
    items: Array<{ id: string; name: string }>;
    selectedIds: string[];
    onToggle: (id: string) => void;
  }) => (
    <div>
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          aria-pressed={selectedIds.includes(item.id)}
          onClick={() => onToggle(item.id)}
        >
          {item.name}
        </button>
      ))}
    </div>
  ),
}));

vi.mock("@/components/visibility-selector", () => ({
  VisibilitySelector: ({
    value,
    options,
    onValueChange,
    children,
  }: {
    value: string;
    options: Array<{ value: string; label: string }>;
    onValueChange: (
      value: "private" | "organization" | "team" | "user",
    ) => void;
    children?: ReactNode;
  }) => (
    <div>
      <div>{value}</div>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          onClick={() =>
            onValueChange(
              option.value as "private" | "organization" | "team" | "user",
            )
          }
        >
          {option.label}
        </button>
      ))}
      {children}
    </div>
  ),
}));

describe("ShareConversationDialog", () => {
  beforeEach(() => {
    mockUseConversationShare.mockReturnValue({
      data: null,
      isLoading: false,
    });
    mockShareMutateAsync.mockReset();
    mockShareMutateAsync.mockResolvedValue({
      id: "share-1",
      visibility: "organization",
      teamIds: [],
      userIds: [],
    });
    mockUnshareMutateAsync.mockReset();
    mockToastSuccess.mockReset();
    Object.defineProperty(window, "location", {
      value: { origin: "http://localhost:3000" },
      configurable: true,
    });
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: vi.fn() },
      configurable: true,
    });
  });

  it("shares a conversation with selected teams", async () => {
    const user = userEvent.setup();

    render(
      <ShareConversationDialog
        conversationId="conv-1"
        open
        onOpenChange={() => {}}
      />,
    );

    await user.click(screen.getByRole("button", { name: /Private/i }));
    await user.click(screen.getByRole("button", { name: /Teams/i }));
    await user.click(screen.getByRole("button", { name: "Engineering" }));
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(mockShareMutateAsync).toHaveBeenCalledWith({
      conversationId: "conv-1",
      visibility: "team",
      teamIds: ["team-1"],
      userIds: [],
      suppressSuccessToast: true,
    });
  });

  it("keeps the dialog open, shows the share URL, and copies it after saving a visible share", async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    const writeText = vi.fn();
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });

    render(
      <ShareConversationDialog
        conversationId="conv-1"
        open
        onOpenChange={onOpenChange}
      />,
    );

    expect(
      screen.queryByText("http://localhost:3000/chat/conv-1"),
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Organization/i }));
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(onOpenChange).not.toHaveBeenCalledWith(false);
    expect(screen.getByText("http://localhost:3000/chat/conv-1")).toBeVisible();
    expect(writeText).toHaveBeenCalledWith("http://localhost:3000/chat/conv-1");
    expect(mockToastSuccess).toHaveBeenCalledWith(
      "Chat visibility updated and share link copied",
    );
  });

  it("shows an inline copyable share URL for saved visible shares", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn();
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    mockUseConversationShare.mockReturnValue({
      data: {
        id: "share-1",
        visibility: "organization",
        teamIds: [],
        userIds: [],
      },
      isLoading: false,
    });

    render(
      <ShareConversationDialog
        conversationId="conv-1"
        open
        onOpenChange={() => {}}
      />,
    );

    expect(screen.getByText("http://localhost:3000/chat/conv-1")).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Copy Link" }),
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Copy to clipboard" }));

    expect(writeText).toHaveBeenCalledWith("http://localhost:3000/chat/conv-1");
  });
});
