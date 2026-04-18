import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ShareConversationDialog } from "./share-conversation-dialog";

const mockShareMutateAsync = vi.fn();
const mockUnshareMutateAsync = vi.fn();

vi.mock("@/lib/chat/chat-share.query", () => ({
  useConversationShare: vi.fn(() => ({
    data: null,
    isLoading: false,
  })),
  useShareConversation: vi.fn(() => ({
    mutateAsync: mockShareMutateAsync,
    isPending: false,
  })),
  useUnshareConversation: vi.fn(() => ({
    mutateAsync: mockUnshareMutateAsync,
    isPending: false,
  })),
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
    mockShareMutateAsync.mockReset();
    mockUnshareMutateAsync.mockReset();
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
    });
  });
});
