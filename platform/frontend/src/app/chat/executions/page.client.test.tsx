import { render, screen } from "@testing-library/react";
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

vi.mock("@/lib/agent-background-execution.query", () => ({
  useCancelAgentExecution: () => cancelState,
  useMyAgentExecution: () => queryState.value,
}));

vi.mock("@/components/agent-execution-terminal", () => ({
  AgentExecutionTerminal: ({ taskId }: { taskId: string }) => (
    <div>Live terminal {taskId}</div>
  ),
}));

vi.mock("@/components/agent-execution-logs", () => ({
  AgentExecutionLogs: () => <div>Retained execution output</div>,
}));

import { BackgroundExecutionChatSession } from "./page.client";

describe("BackgroundExecutionChatSession", () => {
  beforeEach(() => {
    cancelState.isPending = false;
    cancelState.mutate.mockReset();
    queryState.value = {
      data: undefined,
      isPending: false,
      isError: false,
      error: undefined,
      refetch: vi.fn(),
    };
  });

  it("shows the durable startup state while the session is being created", () => {
    queryState.value.isPending = true;

    render(<BackgroundExecutionChatSession taskId="task-1" />);

    expect(screen.getByText("Starting execution…")).toBeInTheDocument();
    expect(
      screen.getByText(
        "Scheduling the workload and preparing its terminal. You can leave this page and come back.",
      ),
    ).toBeInTheDocument();
  });

  it("keeps the last execution visible when a background refresh fails", () => {
    queryState.value.data = execution({
      state: "TASK_STATE_SUBMITTED",
      endedAt: null,
    });
    queryState.value.isError = true;

    render(<BackgroundExecutionChatSession taskId="task-1" />);

    expect(screen.getByText("Starting Codex…")).toBeInTheDocument();
    expect(
      screen.queryByText("Couldn't load this execution"),
    ).not.toBeInTheDocument();
  });

  it("explains when the requested execution cannot be found", () => {
    queryState.value.isError = true;
    queryState.value.error = new Error("Execution not found");

    render(<BackgroundExecutionChatSession taskId="task-1" />);

    expect(
      screen.getByText("Couldn't load this execution"),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "This execution no longer exists, or you no longer have access to it.",
      ),
    ).toBeInTheDocument();
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
});

function execution(overrides: Record<string, unknown>) {
  return {
    taskId: "task-1",
    deploymentName: "agent-task-1",
    prompt: "Implement the small feature",
    state: "TASK_STATE_SUBMITTED",
    endedAt: null,
    agent: {
      id: "00000000-0000-4000-8000-000000000001",
      name: "Codex",
      icon: null,
    },
    ...overrides,
  };
}
