import { EventEmitter } from "node:events";
import { describe, expect, test, vi } from "vitest";
import { WebSocket } from "ws";
import { KubernetesTerminalChannel } from "./kubernetes-terminal-channel";

describe("Kubernetes terminal channel", () => {
  test("frames terminal dimensions only while the attachment is open", () => {
    const { socket, channel } = fixture();
    channel.resize({ cols: 132, rows: 43 });
    const frame = socket.send.mock.calls[0][0];
    expect(frame[0]).toBe(4);
    expect(JSON.parse(frame.subarray(1).toString())).toEqual({
      Width: 132,
      Height: 43,
    });

    for (const readyState of [
      WebSocket.CONNECTING,
      WebSocket.CLOSING,
      WebSocket.CLOSED,
    ]) {
      socket.readyState = readyState;
      channel.resize({ cols: 80, rows: 24 });
    }
    expect(socket.send).toHaveBeenCalledOnce();
  });

  test("detaches once and tolerates a closing transport's late error", () => {
    const { socket, channel } = fixture(WebSocket.CONNECTING);
    const close = vi.fn();
    const error = vi.fn();
    channel.onClose(close);
    channel.onError(error);

    channel.detach();
    channel.detach();
    expect(socket.close).toHaveBeenCalledOnce();
    socket.readyState = WebSocket.OPEN;
    channel.resize({ cols: 132, rows: 43 });
    expect(socket.send).not.toHaveBeenCalled();
    socket.emit("error", new Error("closed before connecting"));
    socket.readyState = WebSocket.CLOSED;
    socket.emit("close");
    expect(close).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    expect(socket.listenerCount("close")).toBe(0);
    expect(socket.listenerCount("error")).toBe(0);
  });

  test("removes subscriptions without suppressing another viewer callback", () => {
    const { socket, channel } = fixture();
    const removedClose = vi.fn();
    const removedError = vi.fn();
    channel.onClose(removedClose)();
    channel.onError(removedError)();
    const close = vi.fn();
    const error = vi.fn();
    channel.onClose(close);
    channel.onError(error);
    const failure = new Error("connection interrupted");
    socket.emit("error", failure);
    socket.readyState = WebSocket.CLOSED;
    socket.emit("close");
    expect(error).toHaveBeenCalledExactlyOnceWith(failure);
    expect(close).toHaveBeenCalledOnce();
    expect(removedError).not.toHaveBeenCalled();
    expect(removedClose).not.toHaveBeenCalled();
    channel.detach();
    expect(socket.close).not.toHaveBeenCalled();
  });

  test.each([
    "before construction",
    "before registration",
  ])("reports a transport closed %s without losing the notification", async (timing) => {
    const { socket, channel } = fixture(
      timing === "before construction" ? WebSocket.CLOSED : WebSocket.OPEN,
    );
    if (timing === "before registration") {
      socket.readyState = WebSocket.CLOSED;
      socket.emit("close");
    }
    const removed = vi.fn();
    channel.onClose(removed)();
    const close = vi.fn();
    channel.onClose(close);
    expect(close).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(close).toHaveBeenCalledOnce();
    expect(removed).not.toHaveBeenCalled();
  });

  test("preserves an error observed before registration and cancels its replay on detach", async () => {
    const { socket, channel } = fixture();
    const failure = new Error("connection interrupted");
    socket.emit("error", failure);
    const error = vi.fn();
    channel.onError(error);
    await Promise.resolve();
    expect(error).toHaveBeenCalledExactlyOnceWith(failure);

    const late = vi.fn();
    channel.onError(late);
    channel.detach();
    await Promise.resolve();
    expect(late).not.toHaveBeenCalled();
  });
});

function fixture(readyState: number = WebSocket.OPEN) {
  const socket = Object.assign(new EventEmitter(), {
    readyState,
    send: vi.fn<(data: Buffer) => void>(),
    close: vi.fn(),
  });
  return {
    socket,
    channel: new KubernetesTerminalChannel(socket as unknown as WebSocket),
  };
}
