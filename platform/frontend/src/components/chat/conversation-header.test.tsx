import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConversationHeader } from "./conversation-header";

const mockUseProject = vi.fn<
  (id?: string) => {
    data: { id: string; name: string; icon: string | null } | null;
  }
>(() => ({ data: null }));

vi.mock("@/lib/projects/projects.query", () => ({
  useProject: (id: string | undefined) => mockUseProject(id),
}));

// biome-ignore lint/suspicious/noExplicitAny: minimal stub of the conversation shape the header reads.
function makeConversation(overrides: Record<string, unknown> = {}): any {
  return {
    id: "conv-1",
    title: "My chat",
    messages: [],
    projectId: null,
    ...overrides,
  };
}

const baseProps = {
  conversationId: "conv-1",
  messageCount: 0,
  isTitleAnimating: false,
  canManageShare: false,
  isShared: false,
  canCreateProject: false,
  onShare: vi.fn(),
  onExportMarkdown: vi.fn(),
  onCreateProject: vi.fn(),
  panel: {
    isOpen: false,
    isArtifactOpen: false,
    isBrowserVisible: false,
    showBrowserButton: false,
    isPlaywrightSetupVisible: false,
    onToggle: vi.fn(),
    onClose: vi.fn(),
    onOpenTab: vi.fn(),
  },
};

describe("ConversationHeader project breadcrumb", () => {
  beforeEach(() => {
    mockUseProject.mockReset();
    mockUseProject.mockReturnValue({ data: null });
  });

  it("shows the project name, emoji, and a link when the chat is in a project", () => {
    mockUseProject.mockReturnValue({
      data: { id: "proj-1", name: "Acme", icon: "🚀" },
    });

    render(
      <ConversationHeader
        {...baseProps}
        conversation={makeConversation({ projectId: "proj-1" })}
      />,
    );

    expect(screen.getByText("Acme")).toBeInTheDocument();
    expect(screen.getByText("🚀")).toBeInTheDocument();
    // The chat title still renders alongside the breadcrumb.
    expect(screen.getByText("My chat")).toBeInTheDocument();
    // The project name links back to the project page.
    const link = screen.getByRole("link", { name: /Acme/ });
    expect(link).toHaveAttribute("href", "/projects/proj-1");
  });

  it("renders no breadcrumb when the chat has no project", () => {
    render(
      <ConversationHeader
        {...baseProps}
        conversation={makeConversation({ projectId: null })}
      />,
    );

    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    expect(screen.getByText("My chat")).toBeInTheDocument();
  });
});
