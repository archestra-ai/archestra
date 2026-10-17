import { render, screen } from "@testing-library/react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { useHasPermissions, useSession } from "@/lib/auth/auth.query";
import {
  preloadConversationActionParts,
  useConversationActions,
} from "./conversation-actions";

vi.mock("next/navigation", () => ({
  usePathname: () => "/chat",
  useRouter: () => ({ push: vi.fn() }),
}));

vi.mock("@/lib/auth/auth.query");

vi.mock("@/lib/chat/chat.query", () => ({
  fetchConversation: vi.fn(),
  useUpdateConversation: () => ({ mutateAsync: vi.fn(), isPending: false }),
  usePinConversation: () => ({ mutate: vi.fn() }),
  useGenerateConversationTitle: () => ({ mutate: vi.fn(), isPending: false }),
  useDeleteConversation: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

vi.mock("@/lib/chat/global-chat.context", () => ({
  useGlobalChat: () => ({ markTitleAnimating: vi.fn() }),
}));

vi.mock("@/lib/projects/projects.query", () => ({
  useProjects: () => ({ data: [] }),
  useCreateProject: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useCreateProjectFromConversation: () => ({
    mutateAsync: vi.fn(),
    isPending: false,
  }),
}));

vi.mock("@/app/_parts/conversation-project-actions", () => ({
  ConversationProjectActions: () => <button type="button">Project</button>,
}));

vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenuItem: ({ children }: { children: React.ReactNode }) => (
    <button type="button">{children}</button>
  ),
  DropdownMenuSeparator: () => <hr />,
}));

beforeEach(() => {
  vi.mocked(useSession).mockReturnValue({
    data: { user: { id: "owner" } },
  } as ReturnType<typeof useSession>);
  vi.mocked(useHasPermissions).mockReturnValue({
    data: true,
  } as ReturnType<typeof useHasPermissions>);
});

// The project picker is a lazy chunk; load it so the menu renders in one pass.
beforeAll(() => preloadConversationActionParts());

describe("useConversationActions", () => {
  it("gives the chat's owner the full list, in menu order", () => {
    render(<Items userId="owner" />);
    expect(
      screen.getAllByRole("button").map((item) => item.textContent),
    ).toEqual([
      "Pin",
      "Rename",
      "Regenerate title",
      "Project",
      "Share",
      "Export Markdown",
      "Delete",
    ]);
  });

  it("offers only export on someone else's chat", () => {
    render(<Items userId="someone-else" />);
    expect(
      screen.getAllByRole("button").map((item) => item.textContent),
    ).toEqual(["Export Markdown"]);
  });

  it("drops share, project and title generation on an encrypted chat", () => {
    render(<Items userId="owner" encryptedChat />);
    expect(
      screen.getAllByRole("button").map((item) => item.textContent),
    ).toEqual(["Pin", "Rename", "Export Markdown", "Delete"]);
  });
});

function Items({
  userId,
  encryptedChat = false,
}: {
  userId: string;
  encryptedChat?: boolean;
}) {
  const { items } = useConversationActions({
    conversation: {
      id: "chat-1",
      title: "Chat",
      userId,
      pinnedAt: null,
      projectId: null,
      encryptedChat,
      origin: "user",
    },
  });
  return <>{items}</>;
}
