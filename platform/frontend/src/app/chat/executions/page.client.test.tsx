import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const queryState = vi.hoisted(() => ({
  value: {
    data: undefined as Record<string, unknown> | undefined,
    isPending: false,
    isError: false,
    error: undefined as Error | undefined,
    refetch: vi.fn(),
  },
}));

const cancelState = vi.hoisted(() => ({
  isPending: false,
  mutate: vi.fn(),
}));

const terminalState = vi.hoisted(() => ({
  props: null as {
    taskId: string;
    title?: string;
    showManualCommand?: boolean;
    showDisconnectedStatus?: boolean;
    onCommandChange?: (command: string | null) => void;
  } | null,
}));

vi.mock("@/lib/agent-background-execution.query", () => ({
  useCancelAgentExecution: () => cancelState,
  useMyAgentExecution: () => queryState.value,
}));

vi.mock("@/components/agent-execution-terminal", () => ({
  AgentExecutionTerminal: (props: NonNullable<typeof terminalState.props>) => {
    terminalState.props = props;
    return <div>Live terminal {props.taskId}</div>;
  },
}));

vi.mock("@/components/agent-execution-logs", () => ({
  AgentExecutionLogs: () => <div>Retained execution output</div>,
}));

const shareDialogState = vi.hoisted(() => ({ open: false }));

// The share dialog owns its own data hooks and tests, so stub it to a marker
// that just reflects its open state — enough to prove the menu item opens it.
vi.mock("@/components/chat/share-agent-execution-dialog", () => ({
  ShareAgentExecutionDialog: ({ open }: { open: boolean }) => {
    shareDialogState.open = open;
    return open ? <div>Share execution dialog</div> : null;
  },
}));

import { BackgroundExecutionChatSession } from "./page.client";

describe("BackgroundExecutionChatSession", () => {
  beforeEach(() => {
    cancelState.isPending = false;
    cancelState.mutate.mockReset();
    terminalState.props = null;
    shareDialogState.open = false;
    queryState.value = {
      data: undefined,
      isPending: false,
      isError: false,
      error: undefined,
      refetch: vi.fn(),
    };
  });

  it("opens the shared terminal while the session is being created", () => {
    queryState.value.isPending = true;

    render(<BackgroundExecutionChatSession taskId="task-1" />);

    expect(screen.getByText("Live terminal task-1")).toBeInTheDocument();
    expect(screen.queryByText("Starting execution…")).not.toBeInTheDocument();
    expect(terminalState.props).toMatchObject({
      showManualCommand: false,
      showDisconnectedStatus: false,
    });
  });

  it("keeps the last execution visible when a background refresh fails", () => {
    queryState.value.data = execution({
      state: "TASK_STATE_SUBMITTED",
      endedAt: null,
    });
    queryState.value.isError = true;

    render(<BackgroundExecutionChatSession taskId="task-1" />);

    expect(screen.getByText("Live terminal task-1")).toBeInTheDocument();
    expect(screen.getByText("Starting")).toBeInTheDocument();
    expect(
      screen.queryByText("Couldn't load this execution"),
    ).not.toBeInTheDocument();
  });

  it("centers only the access notice, in the loader's placement, when the execution cannot be opened", () => {
    queryState.value.isError = true;
    queryState.value.error = new Error("Execution not found");

    render(<BackgroundExecutionChatSession taskId="task-1" />);

    // Rendered as an informational terminal state, not a generic error card.
    expect(screen.getByRole("status")).toBeInTheDocument();
    expect(screen.getByText("Terminal unavailable")).toBeInTheDocument();
    expect(
      screen.getByText(
        "Only the person who started this run can attach to it.",
      ),
    ).toBeInTheDocument();
    // The old full-page error card is gone.
    expect(
      screen.queryByText("Couldn't load this execution"),
    ).not.toBeInTheDocument();
  });

  it("opens the shared live terminal once the execution is running", () => {
    queryState.value.data = execution({
      state: "TASK_STATE_WORKING",
      endedAt: null,
    });

    render(<BackgroundExecutionChatSession taskId="task-1" />);

    expect(screen.getByText("Live terminal task-1")).toBeInTheDocument();
    expect(screen.getByText("Running")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Stop" })).toBeInTheDocument();
    expect(terminalState.props).toMatchObject({
      showManualCommand: false,
      showDisconnectedStatus: false,
    });
  });

  it("moves agent and terminal details into the execution actions menu", async () => {
    const user = userEvent.setup();
    queryState.value.data = execution({
      state: "TASK_STATE_WORKING",
      endedAt: null,
    });

    render(<BackgroundExecutionChatSession taskId="task-1" />);
    act(() => terminalState.props?.onCommandChange?.("kubectl exec example"));

    await user.click(
      screen.getByRole("button", { name: "More execution actions" }),
    );

    expect(
      screen.getByRole("menuitem", { name: "View Agent" }),
    ).toHaveAttribute(
      "href",
      "/agents/00000000-0000-4000-8000-000000000001?section=executions",
    );

    await user.click(
      screen.getByRole("menuitem", { name: "View connection details" }),
    );

    expect(
      screen.getByRole("heading", { name: "Terminal connection details" }),
    ).toBeInTheDocument();
    expect(screen.getByText("kubectl exec example")).toBeInTheDocument();
  });

  it("exposes Share from the actions menu instead of a separate button", async () => {
    const user = userEvent.setup();
    queryState.value.data = execution({
      state: "TASK_STATE_WORKING",
      endedAt: null,
    });

    render(<BackgroundExecutionChatSession taskId="task-1" />);

    // No standalone Share button in the header anymore.
    expect(
      screen.queryByRole("button", { name: "Share" }),
    ).not.toBeInTheDocument();

    await user.click(
      screen.getByRole("button", { name: "More execution actions" }),
    );
    await user.click(screen.getByRole("menuitem", { name: "Share" }));

    // Selecting it opens the share dialog.
    expect(screen.getByText("Share execution dialog")).toBeInTheDocument();
  });

  it("restores retained output after the execution has ended", () => {
    queryState.value.data = execution({
      state: "TASK_STATE_COMPLETED",
      endedAt: "2026-08-28T18:00:00.000Z",
    });

    render(<BackgroundExecutionChatSession taskId="task-1" />);

    expect(screen.getByText("Retained execution output")).toBeInTheDocument();
    expect(screen.getByText("Completed")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Stop" }),
    ).not.toBeInTheDocument();
  });

  it("keeps an attached terminal frame mounted when the execution completes", () => {
    queryState.value.data = execution({
      state: "TASK_STATE_WORKING",
      endedAt: null,
    });
    const { rerender } = render(
      <BackgroundExecutionChatSession taskId="task-1" />,
    );
    act(() => terminalState.props?.onCommandChange?.("kubectl exec example"));

    queryState.value.data = execution({
      state: "TASK_STATE_COMPLETED",
      endedAt: "2026-08-28T18:00:00.000Z",
    });
    rerender(<BackgroundExecutionChatSession taskId="task-1" />);

    expect(screen.getByText("Live terminal task-1")).toBeInTheDocument();
    expect(
      screen.queryByText("Retained execution output"),
    ).not.toBeInTheDocument();
    expect(terminalState.props?.title).toBe("Output");
  });

  it("gives a shared viewer read-only output without owner controls on a live run", () => {
    queryState.value.data = execution({
      state: "TASK_STATE_WORKING",
      endedAt: null,
      viewerRole: "shared",
    });

    render(<BackgroundExecutionChatSession taskId="task-1" />);

    // Read-only log stream instead of the interactive terminal.
    expect(screen.getByText("Retained execution output")).toBeInTheDocument();
    expect(screen.queryByText("Live terminal task-1")).not.toBeInTheDocument();
    // While the run is live, the shared viewer is told why the terminal is read-only.
    expect(
      screen.getByText(/viewing its terminal output in read-only mode/i),
    ).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Read-only terminal");
    // None of the owner-only controls are rendered.
    expect(
      screen.queryByRole("button", { name: "Stop" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Share" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "More execution actions" }),
    ).not.toBeInTheDocument();
  });

  it("shows a shared viewer retained output for an ended run without owner controls", () => {
    queryState.value.data = execution({
      state: "TASK_STATE_COMPLETED",
      endedAt: "2026-08-28T18:00:00.000Z",
      viewerRole: "shared",
    });

    render(<BackgroundExecutionChatSession taskId="task-1" />);

    expect(screen.getByText("Retained execution output")).toBeInTheDocument();
    // No live terminal to contrast, so no read-only banner once the run has ended.
    expect(screen.queryByText(/read-only mode/i)).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Share" }),
    ).not.toBeInTheDocument();
  });
});

function execution(overrides: Record<string, unknown>) {
  return {
    taskId: "task-1",
    title: "Nightly dependency audit",
    deploymentName: "agent-task-1",
    prompt: "Implement the small feature",
    state: "TASK_STATE_SUBMITTED",
    statusReason: null,
    endedAt: null,
    // The viewer is the run's owner unless a test overrides this — owners get
    // the interactive terminal and the Stop/Share/actions controls.
    viewerRole: "owner",
    agent: {
      id: "00000000-0000-4000-8000-000000000001",
      name: "Codex",
      icon: null,
    },
    ...overrides,
  };
}
