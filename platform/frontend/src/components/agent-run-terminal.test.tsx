import type { ServerWebSocketMessage } from "@archestra/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";

const websocketMock = vi.hoisted(() => ({
  connect: vi.fn().mockResolvedValue(undefined),
  isConnected: vi.fn(),
  isReady: vi.fn(),
  onConnectionChange: vi.fn(),
  sendIfConnected: vi.fn(),
  subscribe: vi.fn(),
}));

vi.mock("@/lib/websocket/websocket", () => ({ default: websocketMock }));

import { createAgentRunTransport } from "./agent-run-terminal";

describe("Agent run terminal transport", () => {
  const messageHandlers = new Map<
    string,
    (message: ServerWebSocketMessage) => void
  >();
  let connectionHandler: ((connected: boolean) => void) | undefined;

  function emit(message: ServerWebSocketMessage) {
    messageHandlers.get(message.type)?.(message);
  }

  function attached() {
    emit({
      type: "agent_run_attach_started",
      payload: { runId: "task-1", command: "attach", resourceName: "runtime" },
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    messageHandlers.clear();
    websocketMock.isConnected.mockReturnValue(true);
    websocketMock.isReady.mockReturnValue(true);
    websocketMock.sendIfConnected.mockReturnValue(true);
    websocketMock.connect.mockResolvedValue(undefined);
    websocketMock.subscribe.mockImplementation((type, handler) => {
      messageHandlers.set(type, handler);
      return () => messageHandlers.delete(type);
    });
    websocketMock.onConnectionChange.mockImplementation((handler) => {
      connectionHandler = handler;
      return vi.fn();
    });
  });

  it("waits for server readiness after socket open and subscribes only once", () => {
    websocketMock.isConnected.mockReturnValue(false);
    websocketMock.isReady.mockReturnValue(false);
    let connectionHandler: ((connected: boolean) => void) | undefined;
    websocketMock.onConnectionChange.mockImplementation((handler) => {
      connectionHandler = handler;
      return vi.fn();
    });

    createAgentRunTransport("task-1").open(handlers());

    expect(websocketMock.connect).toHaveBeenCalledOnce();
    expect(websocketMock.sendIfConnected).not.toHaveBeenCalled();
    websocketMock.isConnected.mockReturnValue(true);
    connectionHandler?.(true);
    expect(websocketMock.sendIfConnected).not.toHaveBeenCalled();
    websocketMock.isReady.mockReturnValue(true);
    emit({ type: "websocket_ready", payload: {} });
    emit({ type: "websocket_ready", payload: {} });
    expect(websocketMock.sendIfConnected).toHaveBeenCalledOnce();
    expect(websocketMock.sendIfConnected).toHaveBeenCalledWith({
      type: "subscribe_agent_run_attach",
      payload: { runId: "task-1" },
    });
  });

  it("subscribes immediately when mounted on an already authenticated connection", () => {
    websocketMock.isConnected.mockReturnValue(true);
    websocketMock.onConnectionChange.mockReturnValue(vi.fn());

    createAgentRunTransport("task-1").open(handlers());

    expect(websocketMock.connect).not.toHaveBeenCalled();
    expect(websocketMock.sendIfConnected).toHaveBeenCalledOnce();
  });

  it("allows input only after each attachment is ready and never resends disconnected input", () => {
    const callbacks = handlers();
    const transport = createAgentRunTransport("task-1");
    transport.open(callbacks);
    websocketMock.sendIfConnected.mockClear();

    transport.sendInput("before ready");
    transport.sendResize(100, 30);
    expect(websocketMock.sendIfConnected).not.toHaveBeenCalled();

    attached();
    transport.sendInput("first");
    expect(websocketMock.sendIfConnected).toHaveBeenLastCalledWith({
      type: "agent_run_attach_input",
      payload: { runId: "task-1", data: "first" },
    });

    websocketMock.isConnected.mockReturnValue(false);
    websocketMock.isReady.mockReturnValue(false);
    transport.sendInput("before close callback");
    connectionHandler?.(false);
    transport.sendInput("disconnected");
    transport.sendResize(120, 40);
    expect(websocketMock.sendIfConnected).toHaveBeenCalledTimes(1);
    expect(callbacks.onProgress).toHaveBeenLastCalledWith({
      phase: "attaching",
      message: "Reconnecting to terminal",
      detail: null,
      resourceName: null,
    });
    expect(callbacks.onClosed).not.toHaveBeenCalled();

    websocketMock.isConnected.mockReturnValue(true);
    connectionHandler?.(true);
    transport.sendInput("before server ready");
    expect(websocketMock.sendIfConnected).toHaveBeenCalledTimes(1);
    websocketMock.isReady.mockReturnValue(true);
    emit({ type: "websocket_ready", payload: {} });
    expect(websocketMock.sendIfConnected).toHaveBeenLastCalledWith({
      type: "subscribe_agent_run_attach",
      payload: { runId: "task-1" },
    });
    transport.sendInput("before reattach");
    transport.sendResize(120, 40);
    expect(websocketMock.sendIfConnected).toHaveBeenCalledTimes(2);

    attached();
    transport.sendInput("second");
    transport.sendResize(120, 40);
    expect(websocketMock.sendIfConnected.mock.calls.slice(2)).toEqual([
      [
        {
          type: "agent_run_attach_input",
          payload: { runId: "task-1", data: "second" },
        },
      ],
      [
        {
          type: "agent_run_attach_resize",
          payload: { runId: "task-1", cols: 120, rows: 40 },
        },
      ],
    ]);
  });

  it.each<ServerWebSocketMessage>([
    { type: "agent_run_attach_closed", payload: { runId: "task-1" } },
    {
      type: "agent_run_attach_error",
      payload: { runId: "task-1", error: "Failed to attach" },
    },
  ])("stops sending when the attachment reports $type", (message) => {
    const transport = createAgentRunTransport("task-1");
    transport.open(handlers());
    attached();
    websocketMock.sendIfConnected.mockClear();
    emit(message);

    transport.sendInput("stale");
    transport.sendResize(120, 40);
    expect(websocketMock.sendIfConnected).not.toHaveBeenCalled();
  });

  it("does not let an older open or cleanup make a replacement attachment writable or detach it", () => {
    const transport = createAgentRunTransport("task-1");
    const closeOld = transport.open(handlers());
    const oldStarted = messageHandlers.get("agent_run_attach_started");
    attached();
    transport.open(handlers());
    websocketMock.sendIfConnected.mockClear();

    oldStarted?.({
      type: "agent_run_attach_started",
      payload: { runId: "task-1", command: "old", resourceName: "runtime" },
    });
    transport.sendInput("stale");
    closeOld();
    transport.sendResize(120, 40);
    expect(websocketMock.sendIfConnected).not.toHaveBeenCalled();
  });

  it("does not queue cleanup while disconnected or send input after cleanup", () => {
    const transport = createAgentRunTransport("task-1");
    const close = transport.open(handlers());
    attached();
    websocketMock.sendIfConnected.mockClear();
    websocketMock.isConnected.mockReturnValue(false);
    close();
    websocketMock.isConnected.mockReturnValue(true);
    transport.sendInput("stale");
    transport.sendResize(120, 40);
    connectionHandler?.(true);

    expect(websocketMock.sendIfConnected).toHaveBeenCalledOnce();
    expect(websocketMock.sendIfConnected).toHaveBeenCalledWith({
      type: "unsubscribe_agent_run_attach",
      payload: { runId: "task-1" },
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
