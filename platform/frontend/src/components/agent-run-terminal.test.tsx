import { beforeEach, describe, expect, it, vi } from "vitest";

const websocketMock = vi.hoisted(() => ({
  connect: vi.fn().mockResolvedValue(undefined),
  isConnected: vi.fn(),
  onConnectionChange: vi.fn(),
  send: vi.fn(),
  subscribe: vi.fn(() => vi.fn()),
}));

vi.mock("@/lib/websocket/websocket", () => ({ default: websocketMock }));

import { createAgentRunTransport } from "./agent-run-terminal";

describe("Agent run terminal transport", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    websocketMock.connect.mockResolvedValue(undefined);
    websocketMock.subscribe.mockReturnValue(vi.fn());
  });

  it("subscribes once after a new websocket connection opens", () => {
    websocketMock.isConnected.mockReturnValue(false);
    let connectionHandler: ((connected: boolean) => void) | undefined;
    websocketMock.onConnectionChange.mockImplementation((handler) => {
      connectionHandler = handler;
      return vi.fn();
    });

    createAgentRunTransport("task-1").open(handlers());

    expect(websocketMock.connect).toHaveBeenCalledOnce();
    expect(websocketMock.send).not.toHaveBeenCalled();
    connectionHandler?.(true);
    expect(websocketMock.send).toHaveBeenCalledOnce();
    expect(websocketMock.send).toHaveBeenCalledWith({
      type: "subscribe_agent_run_attach",
      payload: { runId: "task-1" },
    });
  });

  it("subscribes immediately on an existing websocket connection", () => {
    websocketMock.isConnected.mockReturnValue(true);
    websocketMock.onConnectionChange.mockReturnValue(vi.fn());

    createAgentRunTransport("task-1").open(handlers());

    expect(websocketMock.connect).not.toHaveBeenCalled();
    expect(websocketMock.send).toHaveBeenCalledOnce();
  });

  it("shows structured startup progress before the backend reports a phase", () => {
    websocketMock.isConnected.mockReturnValue(false);
    websocketMock.onConnectionChange.mockReturnValue(vi.fn());
    const sessionHandlers = handlers();

    createAgentRunTransport("task-1").open(sessionHandlers);

    expect(sessionHandlers.onProgress).toHaveBeenCalledWith({
      phase: "queued",
      message: "Preparing the run environment",
      detail: null,
      resourceName: null,
    });
  });
});

function handlers() {
  return {
    onStarted: vi.fn(),
    onOutput: vi.fn(),
    onError: vi.fn(),
    onClosed: vi.fn(),
    onProgress: vi.fn(),
  };
}
