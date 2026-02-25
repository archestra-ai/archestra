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
    FakeWebSocket.instances = [];
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
  });

  afterEach(() => {
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
});
