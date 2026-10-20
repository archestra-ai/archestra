import type { ServerWebSocketMessage } from "@archestra/shared";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
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
const playbackContents = vi.hoisted(() => [] as string[]);
vi.mock("@/components/terminal-playback", () => ({
  TerminalPlayback: ({ content }: { content: string }) => {
    playbackContents.push(content);
    return <pre data-testid="terminal-playback">{content}</pre>;
  },
}));

import { AgentRunLogs } from "./agent-run-logs";

describe("AgentRunLogs", () => {
  beforeEach(() => {
    socket.handlers.clear();
    socket.connect.mockClear();
    socket.send.mockClear();
    socket.subscribe.mockClear();
    playbackContents.length = 0;
  });

  it("shows an ended run as loading, then renders its whole history once", () => {
    render(<AgentRunLogs run={completedRun} />);
    expect(screen.getByText("Loading recording")).toBeInTheDocument();
    expect(screen.queryByText("No output recorded")).not.toBeInTheDocument();

    for (const logs of ["one\n", "two\n", "three\n"]) {
      emit({ type: "agent_run_logs", payload: { runId: "task-1", logs } });
    }
    expect(screen.queryByTestId("terminal-playback")).not.toBeInTheDocument();
    emit({
      type: "agent_run_logs_ended",
      payload: { runId: "task-1", source: "full", truncated: false },
    });

    // Each render replays the whole recording, so the frames make one.
    expect(new Set(playbackContents)).toEqual(new Set(["one\ntwo\nthree\n"]));
  });

  it("opens an ended run on the end of its recording and loads the rest on request", () => {
    render(<AgentRunLogs run={completedRun} />);
    expect(socket.send).toHaveBeenLastCalledWith({
      type: "subscribe_agent_run_logs",
      payload: { runId: "task-1", tailBytes: 2 * 1024 * 1024 },
    });
    emit({
      type: "agent_run_logs",
      payload: { runId: "task-1", logs: "the end of the run" },
    });
    emit({
      type: "agent_run_logs_ended",
      payload: {
        runId: "task-1",
        source: "full",
        truncated: false,
        totalBytes: 5 * 1024 * 1024,
        omittedBytes: 3 * 1024 * 1024,
      },
    });

    fireEvent.click(
      screen.getByRole("button", { name: "Load full recording (3.0 MB more)" }),
    );

    expect(socket.send).toHaveBeenLastCalledWith({
      type: "subscribe_agent_run_logs",
      payload: { runId: "task-1" },
    });
    expect(screen.getByText("Loading recording")).toBeInTheDocument();
    emit({
      type: "agent_run_logs",
      payload: { runId: "task-1", logs: "the whole run" },
    });
    emit({
      type: "agent_run_logs_ended",
      payload: { runId: "task-1", source: "full", truncated: false },
    });
    expect(screen.getByTestId("terminal-playback")).toHaveTextContent(
      "the whole run",
    );
    expect(
      screen.queryByRole("button", { name: /Load full recording/ }),
    ).not.toBeInTheDocument();
  });

  it("renders a history whose end message never comes once it goes quiet", () => {
    vi.useFakeTimers();
    try {
      render(<AgentRunLogs run={completedRun} />);
      emit({
        type: "agent_run_logs",
        payload: { runId: "task-1", logs: "quiet output" },
      });
      act(() => vi.advanceTimersByTime(500));
      expect(screen.getByTestId("terminal-playback")).toHaveTextContent(
        "quiet output",
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("renders a live run's output as it streams, a batch at a time", () => {
    vi.useFakeTimers();
    try {
      render(<AgentRunLogs run={{ ...completedRun, endedAt: null }} />);
      expect(screen.getByText("Waiting for output")).toBeInTheDocument();
      emit({ type: "agent_run_logs", payload: { runId: "task-1", logs: "a" } });
      emit({ type: "agent_run_logs", payload: { runId: "task-1", logs: "b" } });
      act(() => vi.advanceTimersByTime(100));
      expect(screen.getByTestId("terminal-playback")).toHaveTextContent("ab");
      emit({ type: "agent_run_logs", payload: { runId: "task-1", logs: "c" } });
      act(() => vi.advanceTimersByTime(100));
      expect(screen.getByTestId("terminal-playback")).toHaveTextContent("abc");
    } finally {
      vi.useRealTimers();
    }
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

  it("renders session history delivered to the stable URL after a continuation", () => {
    render(<AgentRunLogs run={completedRun} sessionId="original-session" />);
    emit({
      type: "agent_run_logs",
      payload: { runId: "original-session", logs: "Earlier turn output\n" },
    });
    emit({
      type: "agent_run_logs",
      payload: { runId: "unrelated-session", logs: "Private unrelated output" },
    });
    emit({
      type: "agent_run_logs",
      payload: { runId: "original-session", logs: "Continuation output\n" },
    });
    emit({
      type: "agent_run_logs_ended",
      payload: { runId: "original-session", source: "full", truncated: false },
    });
    expect(screen.getByTestId("terminal-playback")).toHaveTextContent(
      "Earlier turn output Continuation output",
    );
    expect(
      screen.queryByText(/Private unrelated output/),
    ).not.toBeInTheDocument();
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
      payload: { runId: "task-1", tailBytes: 2 * 1024 * 1024 },
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

  it("keeps terminal recording visible when structured output arrives", () => {
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

    expect(screen.queryByRole("tab")).not.toBeInTheDocument();
    expect(screen.queryByText("Readable transcript")).not.toBeInTheDocument();
    expect(screen.queryByText(/Start of the run/)).not.toBeInTheDocument();

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
