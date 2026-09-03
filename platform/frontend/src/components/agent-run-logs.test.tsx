import type { ServerWebSocketMessage } from "@archestra/shared";
import { act, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentRun } from "@/lib/agent-runtime.query";

const socket = vi.hoisted(() => {
  const handlers = new Map<string, (message: ServerWebSocketMessage) => void>();
  return {
    handlers,
    connect: vi.fn(),
    send: vi.fn(),
    subscribe: vi.fn(
      (type: string, handler: (message: ServerWebSocketMessage) => void) => {
        handlers.set(type, handler);
        return () => handlers.delete(type);
      },
    ),
  };
});

vi.mock("@/lib/websocket/websocket", () => ({ default: socket }));
vi.mock("@/components/terminal-playback", () => ({
  TerminalPlayback: ({ content }: { content: string }) => (
    <pre data-testid="terminal-playback">{content}</pre>
  ),
}));

import { AgentRunLogs } from "./agent-run-logs";

describe("AgentRunLogs", () => {
  beforeEach(() => {
    socket.handlers.clear();
    socket.connect.mockClear();
    socket.send.mockClear();
    socket.subscribe.mockClear();
  });

  it("renders all received transcript chunks and labels a complete recording", () => {
    render(<AgentRunLogs run={completedRun} />);

    emit({
      type: "agent_run_logs",
      payload: { runId: "task-1", logs: "first chunk\n" },
    });
    emit({
      type: "agent_run_logs",
      payload: { runId: "task-1", logs: "second chunk\n" },
    });
    emit({
      type: "agent_run_logs_ended",
      payload: {
        runId: "task-1",
        source: "full",
        truncated: false,
        totalBytes: 25,
      },
    });

    expect(screen.getByTestId("terminal-playback")).toHaveTextContent(
      "first chunk second chunk",
    );
    expect(screen.getByText("Full transcript")).toBeInTheDocument();
  });

  it("warns when only the bounded tail could be retained", () => {
    render(<AgentRunLogs run={completedRun} />);

    emit({
      type: "agent_run_logs",
      payload: { runId: "task-1", logs: "last available output" },
    });
    emit({
      type: "agent_run_logs_ended",
      payload: {
        runId: "task-1",
        source: "tail",
        truncated: true,
        totalBytes: 300_000_000,
      },
    });

    expect(
      screen.getByText("Retained tail only").parentElement,
    ).toHaveAttribute(
      "title",
      "The complete transcript exceeded this deployment's storage limit.",
    );
  });

  it("retries when completed metadata arrives before retained output", async () => {
    render(<AgentRunLogs run={completedRun} />);
    expect(socket.send).toHaveBeenCalledTimes(1);

    emit({
      type: "agent_run_logs_ended",
      payload: {
        runId: "task-1",
        source: "tail",
        truncated: false,
      },
    });

    await waitFor(() => expect(socket.send).toHaveBeenCalledTimes(2));
    expect(socket.send).toHaveBeenLastCalledWith({
      type: "subscribe_agent_run_logs",
      payload: { runId: "task-1" },
    });

    emit({
      type: "agent_run_logs",
      payload: { runId: "task-1", logs: "retained output" },
    });
    emit({
      type: "agent_run_logs_ended",
      payload: {
        runId: "task-1",
        source: "full",
        truncated: false,
        totalBytes: 15,
      },
    });

    expect(screen.getByTestId("terminal-playback")).toHaveTextContent(
      "retained output",
    );
    expect(screen.getByText("Full transcript")).toBeInTheDocument();
  });
});

function emit(message: ServerWebSocketMessage) {
  act(() => socket.handlers.get(message.type)?.(message));
}

const completedRun = {
  taskId: "task-1",
  endedAt: new Date().toISOString(),
} as AgentRun;
