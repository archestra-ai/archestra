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

vi.mock("@/components/ui/multi-select-combobox", () => ({
  MultiSelectCombobox: ({
    options,
    value,
    onChange,
  }: {
    options: Array<{ value: string; label: string }>;
    value: string[];
    onChange: (value: string[]) => void;
  }) => (
    <div>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          onClick={() =>
            onChange(
              value.includes(option.value)
                ? value.filter((item) => item !== option.value)
                : [...value, option.value],
            )
          }
        >
          {option.label}
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
