import type { archestraApiTypes } from "@archestra/shared";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ConversationHeader } from "./conversation-header";

type Conversation = archestraApiTypes.GetChatConversationResponses["200"];
type Panel = Parameters<typeof ConversationHeader>[0]["panel"];

// The header only reads title / messages / projectId off the conversation; a
// minimal shape keeps the fixture readable without the full API type.
function makeConversation(overrides: Partial<Conversation> = {}): Conversation {
  return {
    id: "conv-1",
    title: "My chat",
    messages: [],
    projectId: null,
    ...overrides,
  } as Conversation;
}

function makePanel(overrides: Partial<Panel> = {}): Panel {
  return {
    isOpen: false,
    activeTab: "files",
    scheduledRun: null,
    isArtifactOpen: false,
    isBrowserVisible: false,
    showBrowserButton: true,
    isPlaywrightSetupVisible: false,
    onClose: vi.fn(),
    onOpenTab: vi.fn(),
    ...overrides,
  };
}

function renderHeader(panelOverrides: Partial<Panel> = {}) {
  const panel = makePanel(panelOverrides);
  render(
    <ConversationHeader
      conversationId="conv-1"
      conversation={makeConversation()}
      messageCount={2}
      isTitleAnimating={false}
      canManageShare={false}
      isShared={false}
      canCreateProject={false}
      onShare={vi.fn()}
      onExportMarkdown={vi.fn()}
      onCreateProject={vi.fn()}
      panel={panel}
    />,
  );
  return panel;
}

describe("ConversationHeader — top-bar tab strip", () => {
  it("shows Files / Browser / Apps while the panel is collapsed", () => {
    renderHeader({ isOpen: false });
    expect(screen.getByRole("tab", { name: "Files" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Browser" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Apps" })).toBeInTheDocument();
  });

  it("keeps the same tabs visible while the panel is open (no jump)", () => {
    renderHeader({ isOpen: true });
    expect(screen.getByRole("tab", { name: "Files" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Browser" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Apps" })).toBeInTheDocument();
  });

  it("clicking a DIFFERENT tab switches to it and does not close", async () => {
    const user = userEvent.setup();
    // "files" is active + open; clicking Browser must switch, not collapse
    // (this is the regression: it used to close the whole panel).
    const panel = renderHeader({ isOpen: true, activeTab: "files" });

    await user.click(screen.getByRole("tab", { name: "Browser" }));

    expect(panel.onOpenTab).toHaveBeenCalledWith("browser");
    expect(panel.onClose).not.toHaveBeenCalled();
  });

  it("clicking the ACTIVE tab while open collapses the panel (and does not reopen)", async () => {
    const user = userEvent.setup();
    const panel = renderHeader({ isOpen: true, activeTab: "files" });

    await user.click(screen.getByRole("tab", { name: "Files" }));

    expect(panel.onClose).toHaveBeenCalledTimes(1);
    expect(panel.onOpenTab).not.toHaveBeenCalled();
  });

  it("clicking the active tab while collapsed opens it", async () => {
    const user = userEvent.setup();
    const panel = renderHeader({ isOpen: false, activeTab: "files" });

    await user.click(screen.getByRole("tab", { name: "Files" }));

    expect(panel.onOpenTab).toHaveBeenCalledWith("files");
    expect(panel.onClose).not.toHaveBeenCalled();
  });

  it("hides Browser when the browser button is unavailable", () => {
    renderHeader({ showBrowserButton: false });
    expect(
      screen.queryByRole("tab", { name: "Browser" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Files" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Apps" })).toBeInTheDocument();
  });

  it("disables Browser while Playwright setup is pending", () => {
    renderHeader({ isPlaywrightSetupVisible: true });
    expect(screen.getByRole("tab", { name: "Browser" })).toBeDisabled();
  });

  it("shows the Runs tab only for scheduled-run chats", () => {
    renderHeader({ scheduledRun: null });
    expect(screen.queryByRole("tab", { name: "Runs" })).not.toBeInTheDocument();
  });

  it("renders the Runs tab when the chat is a scheduled run", () => {
    renderHeader({ scheduledRun: { triggerId: "t1", runId: null } });
    expect(screen.getByRole("tab", { name: "Runs" })).toBeInTheDocument();
  });
});
