import { createUIMessageStream, type UIMessageChunk } from "ai";
import { afterEach, expect, test, vi } from "vitest";
import { withChatHeartbeats } from "./heartbeat-stream";

afterEach(() => {
  vi.useRealTimers();
});

test("keeps heartbeats through SDK finish persistence, then closes without leaking a timer", async () => {
  vi.useFakeTimers();
  let finishPersistence!: () => void;
  const persistence = new Promise<void>((resolve) => {
    finishPersistence = resolve;
  });
  const onFinish = vi.fn(() => persistence);
  const source = createUIMessageStream({
    execute({ writer }) {
      writer.write({ type: "start", messageId: "assistant" });
      writer.write({ type: "text-start", id: "text" });
      writer.write({ type: "text-delta", id: "text", delta: "Done" });
      writer.write({ type: "text-end", id: "text" });
      writer.write({ type: "finish", finishReason: "stop" });
    },
    onFinish,
  });
  const reader = withChatHeartbeats(source).getReader();
  const types: string[] = [];
  while (types.at(-1) !== "finish") {
    const { done, value } = await reader.read();
    expect(done).toBe(false);
    types.push(value?.type ?? "");
  }
  expect(types).toEqual([
    "start",
    "text-start",
    "text-delta",
    "text-end",
    "finish",
  ]);

  // Longer than the browser's 40s stall threshold, after the finish chunk.
  for (let i = 0; i < 9; i++) {
    await vi.advanceTimersByTimeAsync(5000);
    expect(await reader.read()).toEqual({
      done: false,
      value: {
        type: "data-heartbeat",
        data: { timestamp: Date.now() },
        transient: true,
      },
    });
  }
  expect(onFinish).toHaveBeenCalledOnce();
  finishPersistence();
  expect(await reader.read()).toEqual({ done: true, value: undefined });
  await vi.advanceTimersByTimeAsync(5000);
  expect(vi.getTimerCount()).toBe(0);
});

test("sends heartbeats before the first model chunk and forwards source failures", async () => {
  vi.useFakeTimers();
  let sourceController!: ReadableStreamDefaultController<UIMessageChunk>;
  const reader = withChatHeartbeats(
    new ReadableStream<UIMessageChunk>({
      start(controller) {
        sourceController = controller;
      },
    }),
  ).getReader();

  await vi.advanceTimersByTimeAsync(5000);
  expect((await reader.read()).value?.type).toBe("data-heartbeat");
  const error = new Error("Source failed");
  sourceController.error(error);
  await expect(reader.read()).rejects.toBe(error);
  expect(vi.getTimerCount()).toBe(0);
});

test("cancels the source and stops heartbeats when both tee consumers disconnect", async () => {
  vi.useFakeTimers();
  const cancel = vi.fn();
  const [response, persistence] = withChatHeartbeats(
    new ReadableStream<UIMessageChunk>({ cancel }),
  ).tee();

  // A browser disconnect alone must not stop the background run or its replay.
  const responseCancelled = response.cancel("browser disconnected");
  const reader = persistence.getReader();
  await vi.advanceTimersByTimeAsync(5000);
  expect((await reader.read()).value?.type).toBe("data-heartbeat");
  expect(cancel).not.toHaveBeenCalled();

  await reader.cancel("run cancelled");
  await responseCancelled;
  expect(cancel).toHaveBeenCalledWith([
    "browser disconnected",
    "run cancelled",
  ]);
  expect(vi.getTimerCount()).toBe(0);
});
