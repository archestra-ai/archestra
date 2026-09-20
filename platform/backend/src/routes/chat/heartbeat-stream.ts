import type { UIMessageChunk } from "ai";

/** Keep the transport alive until the source closes, including async onFinish work. */
export function withChatHeartbeats(
  source: ReadableStream<UIMessageChunk>,
): ReadableStream<UIMessageChunk> {
  const reader = source.getReader();
  let cancelled = false;
  let interval: ReturnType<typeof setInterval>;

  return new ReadableStream<UIMessageChunk>({
    async start(controller) {
      interval = setInterval(() => {
        controller.enqueue({
          type: "data-heartbeat",
          data: { timestamp: Date.now() },
          transient: true,
        });
      }, 5000);

      try {
        while (!cancelled) {
          const { done, value } = await reader.read();
          if (cancelled) return;
          if (done) {
            controller.close();
            return;
          }
          controller.enqueue(value);
        }
      } catch (error) {
        if (!cancelled) controller.error(error);
      } finally {
        clearInterval(interval);
        reader.releaseLock();
      }
    },
    cancel(reason) {
      cancelled = true;
      clearInterval(interval);
      return reader.cancel(reason);
    },
  });
}
