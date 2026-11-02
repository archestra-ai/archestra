import type { UIMessage } from "@ai-sdk/react";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ChatTransport, UIMessageChunk } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useOffStreamChat } from "./use-off-stream-chat";

describe("useOffStreamChat", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("delivers message updates in a later task, coalesced", () => {
    vi.useFakeTimers();
    let renders = 0;
    const { result } = renderHook(() => {
      renders += 1;
      return useOffStreamChat({ experimental_throttle: 100 });
    });
    const rendersBefore = renders;

    act(() => {
      result.current.setMessages([message("a")]);
      result.current.setMessages([message("a"), message("b")]);
      result.current.setMessages([message("a"), message("b"), message("c")]);
    });

    // Delivered synchronously means `useChat` no longer subscribes through
    // Chat's `~registerMessagesCallback`, which useOffStreamChat wraps.
    expect(
      result.current.messages,
      "message updates reached React inside the SDK call",
    ).toEqual([]);

    act(() => {
      vi.advanceTimersByTime(0);
    });

    expect(result.current.messages.map(({ id }) => id)).toEqual([
      "a",
      "b",
      "c",
    ]);
    expect(renders - rendersBefore).toBe(1);
  });

  it("spaces deliveries by the throttle window", () => {
    vi.useFakeTimers();
    const { result } = renderHook(() =>
      useOffStreamChat({ experimental_throttle: 100 }),
    );

    act(() => {
      result.current.setMessages([message("a")]);
      vi.advanceTimersByTime(0);
    });
    expect(result.current.messages).toHaveLength(1);

    act(() => {
      vi.advanceTimersByTime(30);
      result.current.setMessages([message("a"), message("b")]);
      vi.advanceTimersByTime(69);
    });
    expect(result.current.messages).toHaveLength(1);

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current.messages).toHaveLength(2);
  });

  it("drops a pending delivery when the component unmounts", () => {
    vi.useFakeTimers();
    const { result, unmount } = renderHook(() =>
      useOffStreamChat({ experimental_throttle: 100 }),
    );

    const timersBefore = vi.getTimerCount();
    act(() => {
      result.current.setMessages([message("a")]);
    });
    expect(vi.getTimerCount()).toBe(timersBefore + 1);

    unmount();

    expect(vi.getTimerCount()).toBe(timersBefore);
  });

  it("streams a turn to completion and calls the latest callbacks", async () => {
    const firstOnFinish = vi.fn();
    const latestOnFinish = vi.fn();
    const { result, rerender } = renderHook(
      ({ onFinish }) =>
        useOffStreamChat({
          transport: bufferedTransport(["Hello", " world"]),
          experimental_throttle: 100,
          onFinish,
        }),
      { initialProps: { onFinish: firstOnFinish } },
    );
    rerender({ onFinish: latestOnFinish });

    await act(async () => {
      await result.current.sendMessage({ text: "Hi" });
    });

    await waitFor(() =>
      expect(result.current.messages.at(-1)?.parts).toContainEqual(
        expect.objectContaining({ type: "text", text: "Hello world" }),
      ),
    );
    expect(result.current.status).toBe("ready");
    expect(latestOnFinish).toHaveBeenCalledTimes(1);
    expect(firstOnFinish).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// Internal
// ===========================================================================

function message(id: string): UIMessage {
  return { id, role: "user", parts: [{ type: "text", text: id }] };
}

function bufferedTransport(deltas: string[]): ChatTransport<UIMessage> {
  const chunks: UIMessageChunk[] = [
    { type: "start", messageId: "assistant-1" },
    { type: "text-start", id: "text-1" },
    ...deltas.map((delta) => ({
      type: "text-delta" as const,
      id: "text-1",
      delta,
    })),
    { type: "text-end", id: "text-1" },
    { type: "finish" },
  ];
  return {
    async sendMessages() {
      return new ReadableStream<UIMessageChunk>({
        start(controller) {
          for (const chunk of chunks) {
            controller.enqueue(chunk);
          }
          controller.close();
        },
      });
    },
    async reconnectToStream() {
      return null;
    },
  };
}
