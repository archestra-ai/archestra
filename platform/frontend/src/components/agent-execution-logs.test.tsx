import type { ServerWebSocketMessage } from "@archestra/shared";
import { act, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentExecution } from "@/lib/agent-background-execution.query";

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

import { AgentExecutionLogs } from "./agent-execution-logs";

describe("AgentExecutionLogs", () => {
  beforeEach(() => {
    socket.handlers.clear();
    socket.connect.mockClear();
    socket.send.mockClear();
    socket.subscribe.mockClear();
  });

  it("renders all received transcript chunks and labels a complete recording", () => {
    render(<AgentExecutionLogs execution={completedExecution} />);

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
    render(<AgentExecutionLogs execution={completedExecution} />);

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
});

function emit(message: ServerWebSocketMessage) {
  act(() => socket.handlers.get(message.type)?.(message));
}

const completedExecution = {
  taskId: "task-1",
  endedAt: new Date().toISOString(),
} as AgentExecution;
