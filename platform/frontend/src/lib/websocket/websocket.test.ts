import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

type WebSocketListener = (event: Event & { data?: string }) => void;

class FakeWebSocket {
  static OPEN = 1;
  static CONNECTING = 0;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readyState = FakeWebSocket.CONNECTING;
  sent: string[] = [];
  private listeners = new Map<string, Set<WebSocketListener>>();

  constructor(_url: string) {
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type: string, handler: WebSocketListener): void {
    if (!this.listeners.has(type)) {
      this.listeners.set(type, new Set());
    }
    this.listeners.get(type)?.add(handler);
  }

  removeEventListener(type: string, handler: WebSocketListener): void {
    this.listeners.get(type)?.delete(handler);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.emit("close", new Event("close"));
  }

  triggerOpen(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.emit("open", new Event("open"));
  }

  triggerMessage(data: string): void {
    this.emit("message", { data } as Event & { data: string });
  }

  private emit(type: string, event: Event & { data?: string }): void {
    const handlers = this.listeners.get(type);
    if (!handlers) return;
    for (const handler of handlers) {
      handler(event);
    }
  }
}

describe("WebSocketService", () => {
  const OriginalWebSocket = globalThis.WebSocket;

  beforeEach(() => {
    vi.useFakeTimers();
    FakeWebSocket.instances = [];
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    globalThis.WebSocket = OriginalWebSocket;
  });

  test("queues messages until the socket is open", async () => {
    vi.resetModules();
    const { default: websocketService } = await import("./websocket");

    await websocketService.connect();
    const socket = FakeWebSocket.instances[0];
    expect(socket).toBeDefined();

    const testMessage = {
      type: "unsubscribe_browser_stream" as const,
      payload: { conversationId: "test-conversation-id" },
    };
    websocketService.send(testMessage);
    expect(socket.sent).toHaveLength(0);

    socket.triggerOpen();
    expect(socket.sent).toHaveLength(1);
    expect(JSON.parse(socket.sent[0])).toEqual(testMessage);
  });

  test("sends immediately when the socket is open", async () => {
    vi.resetModules();
    const { default: websocketService } = await import("./websocket");

    await websocketService.connect();
    const socket = FakeWebSocket.instances[0];
    socket.triggerOpen();

    websocketService.send({
      type: "unsubscribe_browser_stream",
      payload: { conversationId: "test-conversation-id" },
    });
    expect(socket.sent).toHaveLength(1);
  });

  test("tracks delayed authenticated readiness separately from native socket openness", async () => {
    vi.resetModules();
    const { default: websocketService } = await import("./websocket");
    const readiness = vi.fn(() => websocketService.isReady());
    websocketService.subscribe("websocket_ready", readiness);
    await websocketService.connect();
    const socket = FakeWebSocket.instances[0];
    socket.triggerOpen();
    await vi.advanceTimersByTimeAsync(5_000);

    expect(websocketService.isConnected()).toBe(true);
    expect(websocketService.isReady()).toBe(false);
    socket.triggerMessage(
      JSON.stringify({ type: "websocket_ready", payload: {} }),
    );
    expect(readiness).toHaveLastReturnedWith(true);
    expect(websocketService.isReady()).toBe(true);

    socket.close();
    expect(websocketService.isReady()).toBe(false);
    await websocketService.connect();
    const replacement = FakeWebSocket.instances[1];
    replacement.triggerOpen();
    socket.triggerMessage(
      JSON.stringify({ type: "websocket_ready", payload: {} }),
    );
    expect(websocketService.isReady()).toBe(false);
    expect(readiness).toHaveBeenCalledOnce();
    replacement.triggerMessage(
      JSON.stringify({ type: "websocket_ready", payload: {} }),
    );
    expect(websocketService.isReady()).toBe(true);
    websocketService.disconnect();
    expect(websocketService.isReady()).toBe(false);
  });

  test("does not queue a current-socket-only message while disconnected", async () => {
    vi.resetModules();
    const { default: websocketService } = await import("./websocket");
    const message = {
      type: "agent_run_attach_input" as const,
      payload: { runId: "task-1", data: "do not replay" },
    };

    expect(websocketService.sendIfConnected(message)).toBe(false);
    expect(FakeWebSocket.instances).toHaveLength(0);

    await websocketService.connect();
    const socket = FakeWebSocket.instances[0];
    socket.triggerOpen();
    expect(socket.sent).toEqual([]);
    expect(websocketService.sendIfConnected(message)).toBe(true);
    expect(socket.sent.map((data) => JSON.parse(data))).toEqual([message]);
    websocketService.disconnect();
  });

  test("does not replay a current-socket-only message after a send failure", async () => {
    vi.resetModules();
    const { default: websocketService } = await import("./websocket");
    await websocketService.connect();
    const socket = FakeWebSocket.instances[0];
    socket.triggerOpen();
    vi.spyOn(socket, "send").mockImplementationOnce(() => {
      throw new Error("Socket closed during send");
    });

    expect(
      websocketService.sendIfConnected({
        type: "agent_run_attach_input",
        payload: { runId: "task-1", data: "delivery unknown" },
      }),
    ).toBe(false);
    socket.close();
    await websocketService.connect();
    const replacement = FakeWebSocket.instances[1];
    replacement.triggerOpen();

    expect(replacement.sent).toEqual([]);
    websocketService.disconnect();
  });

  test("retries a stalled handshake without waiting for close and ignores that socket's late events", async () => {
    vi.resetModules();
    const { default: websocketService } = await import("./websocket");
    const onConnection = vi.fn();
    const onOutput = vi.fn();
    websocketService.onConnectionChange(onConnection);
    websocketService.subscribe("agent_run_attach_output", onOutput);
    await websocketService.connect();
    const stalled = FakeWebSocket.instances[0];
    const close = vi.spyOn(stalled, "close").mockImplementation(() => {
      stalled.readyState = FakeWebSocket.CLOSING;
    });

    await vi.advanceTimersByTimeAsync(9_999);
    expect(close).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(close).toHaveBeenCalledOnce();
    expect(onConnection).toHaveBeenCalledWith(false);
    await vi.advanceTimersByTimeAsync(1_300);
    expect(FakeWebSocket.instances).toHaveLength(2);
    const replacement = FakeWebSocket.instances[1];

    stalled.triggerOpen();
    stalled.triggerMessage(
      JSON.stringify({
        type: "agent_run_attach_output",
        payload: { runId: "task-1", data: "stale output" },
      }),
    );
    close.mockRestore();
    stalled.close();
    expect(websocketService.isConnected()).toBe(false);
    expect(onConnection.mock.calls).toEqual([[false]]);
    expect(onOutput).not.toHaveBeenCalled();

    replacement.triggerOpen();
    expect(websocketService.isConnected()).toBe(true);
    expect(onConnection.mock.calls).toEqual([[false], [true]]);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(websocketService.isConnected()).toBe(true);
    websocketService.disconnect();
  });

  test("clears the handshake deadline when a socket closes before it opens", async () => {
    vi.resetModules();
    const { default: websocketService } = await import("./websocket");
    const onConnection = vi.fn();
    websocketService.onConnectionChange(onConnection);
    await websocketService.connect();
    await vi.advanceTimersByTimeAsync(500);
    FakeWebSocket.instances[0].close();
    await vi.advanceTimersByTimeAsync(1_300);
    const replacement = FakeWebSocket.instances[1];
    replacement.triggerOpen();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(onConnection.mock.calls).toEqual([[false], [true]]);
    expect(websocketService.isConnected()).toBe(true);
    websocketService.disconnect();
  });

  test("cancels a pending handshake on manual disconnect and allows an explicit reconnect", async () => {
    vi.resetModules();
    const { default: websocketService } = await import("./websocket");
    const onConnection = vi.fn();
    websocketService.onConnectionChange(onConnection);
    await websocketService.connect();
    const abandoned = FakeWebSocket.instances[0];
    const close = vi.spyOn(abandoned, "close").mockImplementation(() => {
      abandoned.readyState = FakeWebSocket.CLOSING;
    });
    websocketService.disconnect();
    await vi.advanceTimersByTimeAsync(30_000);

    expect(close).toHaveBeenCalledOnce();
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(onConnection.mock.calls).toEqual([[false]]);
    await websocketService.connect();
    expect(FakeWebSocket.instances).toHaveLength(2);
    FakeWebSocket.instances[1].triggerOpen();
    abandoned.triggerOpen();
    close.mockRestore();
    abandoned.close();
    expect(websocketService.isConnected()).toBe(true);
    expect(onConnection.mock.calls).toEqual([[false], [true]]);
    websocketService.disconnect();
  });
});
