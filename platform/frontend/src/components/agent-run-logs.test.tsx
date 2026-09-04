import type { ServerWebSocketMessage } from "@archestra/shared";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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
    expect(screen.getByText("Complete terminal recording")).toBeInTheDocument();
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
    expect(screen.getByText("Complete terminal recording")).toBeInTheDocument();
  });

  it("opens a normalized readable transcript and keeps terminal replay available", async () => {
    const user = userEvent.setup();
    render(<AgentRunLogs run={completedRun} />);

    emit({
      type: "agent_run_logs",
      payload: { runId: "task-1", logs: "terminal frame\n" },
    });
    emit({
      type: "agent_run_logs",
      payload: {
        runId: "task-1",
        channel: "readable",
        logs: JSON.stringify({
          version: 1,
          provider: "claude-code",
          entries: [
            { type: "message", role: "user", text: "Start of the run" },
            { type: "message", role: "assistant", text: "End of the run" },
          ],
        }),
      },
    });
    emit({
      type: "agent_run_logs_ended",
      payload: {
        runId: "task-1",
        source: "full",
        truncated: false,
        readable: {
          provider: "claude-code",
          version: 1,
          totalBytes: 100,
        },
      },
    });

    expect(screen.getByText(/Start of the run/)).toBeInTheDocument();
    expect(screen.getByText(/End of the run/)).toBeInTheDocument();
    expect(screen.getAllByText("Readable transcript")).toHaveLength(2);

    await user.click(screen.getByRole("tab", { name: "Terminal replay" }));

    expect(screen.getByTestId("terminal-playback")).toHaveTextContent(
      "terminal frame",
    );
    expect(screen.getByText("Complete terminal recording")).toBeInTheDocument();
  });
});

function emit(message: ServerWebSocketMessage) {
  act(() => socket.handlers.get(message.type)?.(message));
}

const completedRun = {
  taskId: "task-1",
  endedAt: new Date().toISOString(),
} as AgentRun;
