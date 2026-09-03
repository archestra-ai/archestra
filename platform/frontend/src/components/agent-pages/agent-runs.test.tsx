import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentRun } from "@/lib/agent-runtime.query";

const { state, refetch } = vi.hoisted(() => ({
  state: { runs: [] as AgentRun[] },
  refetch: vi.fn(),
}));

vi.mock("@/lib/agent-runtime.query", () => ({
  useAgentRuns: () => ({
    data: state.runs,
    isPending: false,
    isError: false,
    refetch,
  }),
}));

vi.mock("@/lib/auth/auth.query", () => ({
  useSession: () => ({ data: { user: { id: "user-1" } } }),
}));

vi.mock("@/components/agent-run-state", () => ({
  AgentRunState: () => <span>Run state</span>,
}));

vi.mock("@/components/agent-run-terminal", () => ({
  AgentRunTerminal: () => <div>Live terminal</div>,
}));

vi.mock("@/components/agent-run-logs", () => ({
  AgentRunLogs: () => <div>Retained output</div>,
}));

import { AgentRuns } from "./agent-runs";

describe("AgentRuns", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.runs = [createRun(null)];
  });

  it("shows the live terminal while a run is active and retained output when it ends", () => {
    const view = render(<AgentRuns agentId="agent-1" />);

    expect(screen.getByText("Live terminal")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Output" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Terminal" })).toBeNull();

    state.runs = [createRun("2026-09-03T20:00:05.000Z")];
    view.rerender(<AgentRuns agentId="agent-1" />);

    expect(screen.getByText("Retained output")).toBeInTheDocument();
    expect(screen.queryByText("Live terminal")).toBeNull();
    expect(screen.queryByRole("button", { name: "Output" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Terminal" })).toBeNull();
  });
});

function createRun(endedAt: string | null): AgentRun {
  return {
    id: "run-1",
    organizationId: "org-1",
    taskId: "12345678-abcd-4000-8000-123456789abc",
    agentId: "agent-1",
    actorKind: "user",
    actorId: "user-1",
    actorUserId: "user-1",
    title: "Native TUI verification",
    pinnedAt: null,
    projectId: null,
    workloadName: "agent-agent-1-task-1",
    backend: "kubernetes",
    runtimeScope: "archestra-dev",
    virtualApiKeyId: null,
    startedAt: "2026-09-03T20:00:00.000Z",
    endedAt,
    state: endedAt ? "TASK_STATE_COMPLETED" : "TASK_STATE_WORKING",
    statusReason: null,
    stateChangedAt: "2026-09-03T20:00:05.000Z",
  };
}
