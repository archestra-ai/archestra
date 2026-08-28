import { beforeEach, describe, expect, it, vi } from "vitest";

const websocketMock = vi.hoisted(() => ({
  connect: vi.fn().mockResolvedValue(undefined),
  isConnected: vi.fn(),
  onConnectionChange: vi.fn(),
  send: vi.fn(),
  subscribe: vi.fn(() => vi.fn()),
}));

vi.mock("@/lib/websocket/websocket", () => ({ default: websocketMock }));

import { createAgentExecutionTransport } from "./agent-execution-terminal";

describe("Agent execution terminal transport", () => {
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

    createAgentExecutionTransport("task-1").open(handlers());

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

    createAgentExecutionTransport("task-1").open(handlers());

    expect(websocketMock.connect).not.toHaveBeenCalled();
    expect(websocketMock.send).toHaveBeenCalledOnce();
  });
});

function handlers() {
  return {
    onStarted: vi.fn(),
    onOutput: vi.fn(),
    onError: vi.fn(),
    onClosed: vi.fn(),
  };
}
