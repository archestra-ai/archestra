import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useRouter } from "next/navigation";
import { describe, expect, it, vi } from "vitest";
import { useResolveRunChat } from "@/components/scheduled-tasks/use-resolve-run-chat";
import { useHasPermissions, useSession } from "@/lib/auth/auth.query";
import {
  useRunScheduleTriggerNow,
  useScheduleTrigger,
} from "@/lib/schedule-trigger.query";
import { RightSidePanel } from "./right-side-panel";

vi.mock("@/lib/auth/auth.query");
vi.mock("next/navigation");
vi.mock("@/components/scheduled-tasks/use-resolve-run-chat", () => ({
  useResolveRunChat: vi.fn(() => ({ resolve: vi.fn(), isResolving: false })),
}));
vi.mock("@/lib/schedule-trigger.query");
vi.mock("@/components/scheduled-tasks/schedule-runs-list", () => ({
  ScheduleRunsList: () => <div>Runs list</div>,
}));

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
  it("runs the current schedule and disables Start New Run while submitting", async () => {
    const push = vi.fn();
    vi.mocked(useRouter).mockReturnValue({ push } as unknown as ReturnType<
      typeof useRouter
    >);
    const resolve = vi.fn();
    vi.mocked(useResolveRunChat).mockReturnValue({
      resolve,
      isResolving: false,
    });
    const mutate = vi.fn((_id, options) =>
      options.onSuccess({ id: "new-run" }),
    );
    vi.mocked(useScheduleTrigger).mockReturnValue({
      data: { name: "Report", actorUserId: "owner" },
    } as ReturnType<typeof useScheduleTrigger>);
    vi.mocked(useSession).mockReturnValue({
      data: { user: { id: "owner" } },
    } as ReturnType<typeof useSession>);
    vi.mocked(useHasPermissions).mockReturnValue({ data: true } as ReturnType<
      typeof useHasPermissions
    >);
    vi.mocked(useRunScheduleTriggerNow).mockReturnValue({
      mutate,
      isPending: false,
    } as unknown as ReturnType<typeof useRunScheduleTriggerNow>);
    const props = {
      isOpen: true,
      activeTab: "runs" as const,
      onClose: vi.fn(),
      canShowBrowser: false,
      conversationId: "chat-1",
      projectId: "project-1",
      scheduledRun: { triggerId: "schedule-1", runId: "run-1" },
    };
    const { rerender } = render(<RightSidePanel {...props} />);
    await userEvent.click(
      screen.getByRole("button", { name: "Start New Run" }),
    );
    expect(mutate).toHaveBeenCalledWith("schedule-1", expect.any(Object));
    expect(push).not.toHaveBeenCalled();
    expect(resolve).toHaveBeenCalledWith("schedule-1", "new-run");
    vi.mocked(useRunScheduleTriggerNow).mockReturnValue({
      mutate,
      isPending: true,
    } as unknown as ReturnType<typeof useRunScheduleTriggerNow>);
    rerender(<RightSidePanel {...props} />);
    expect(
      screen.getByRole("button", { name: "Start New Run" }),
    ).toBeDisabled();
    vi.mocked(useHasPermissions).mockReturnValue({ data: false } as ReturnType<
      typeof useHasPermissions
    >);
    rerender(<RightSidePanel {...props} />);
    expect(
      screen.queryByRole("button", { name: "Start New Run" }),
    ).not.toBeInTheDocument();
  });

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
