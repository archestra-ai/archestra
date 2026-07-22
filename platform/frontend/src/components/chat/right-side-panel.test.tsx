import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { RightSidePanel } from "./right-side-panel";

// Stub the heavy children / context so the test exercises the panel's own
// content selection in isolation (the tab strip now lives in the header).
vi.mock("@/components/chat/apps-context", () => ({
  useApps: () => ({
    apps: [],
    setPortalTarget: vi.fn(),
    setSettingsOpen: vi.fn(),
  }),
}));
vi.mock("@/components/chat/resizable-right-panel", () => ({
  ResizableRightPanel: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
}));
vi.mock("@/components/chat/conversation-files-panel", () => ({
  ConversationFilesPanel: () => <div>Files content</div>,
}));
vi.mock("@/components/chat/browser-panel", () => ({
  BrowserPanel: () => <div>Browser content</div>,
}));

function renderPanel(
  overrides: Partial<Parameters<typeof RightSidePanel>[0]> = {},
) {
  render(
    <RightSidePanel
      isOpen
      activeTab="files"
      onClose={vi.fn()}
      canShowBrowser
      conversationId="conv-1"
      {...overrides}
    />,
  );
}

describe("RightSidePanel — content only", () => {
  it("renders nothing when collapsed", () => {
    const { container } = render(
      <RightSidePanel
        isOpen={false}
        activeTab="files"
        onClose={vi.fn()}
        canShowBrowser
        conversationId="conv-1"
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("has no collapse/close button (the header tab strip drives collapse)", () => {
    renderPanel();
    expect(
      screen.queryByRole("button", { name: "Close panel" }),
    ).not.toBeInTheDocument();
  });

  it("renders the Files content for the files tab", () => {
    renderPanel({ activeTab: "files" });
    expect(screen.getByText("Files content")).toBeInTheDocument();
  });

  it("renders the Browser content for the browser tab", () => {
    renderPanel({ activeTab: "browser", canShowBrowser: true });
    expect(screen.getByText("Browser content")).toBeInTheDocument();
  });

  it("falls back to Files when browser is unavailable", () => {
    renderPanel({ activeTab: "browser", canShowBrowser: false });
    expect(screen.getByText("Files content")).toBeInTheDocument();
    expect(screen.queryByText("Browser content")).not.toBeInTheDocument();
  });

  it("shows the Apps empty state for the apps tab", () => {
    renderPanel({ activeTab: "apps" });
    expect(screen.getByText("No Apps in this chat")).toBeInTheDocument();
  });
});
