import {
  DefaultChatTransport,
  type HttpChatTransportInitOptions,
  type UIMessage,
} from "ai";

/**
 * How long a reattach waits for the active-run endpoint to answer. The replay
 * response starts immediately, so a request still pending after this is hung,
 * and the chat status stays "ready" while it waits, so the stall timer cannot
 * see it.
 */
const RECONNECT_CONNECT_TIMEOUT_MS = 15_000;

/**
 * The AI SDK's reconnect request carries no abort signal, and `Chat.stop()`
 * only aborts the request it started through `sendMessages`. A resumed stream
 * (mount-time resume, duplicate-run reattach, stall recovery) could therefore
 * be neither stopped nor timed out. This transport gives the reconnect its own
 * abort controller and a connect timeout.
 */
export class ResumableChatTransport extends DefaultChatTransport<UIMessage> {
  private readonly reconnectSignal: { current: AbortSignal | null };
  private reconnectController: AbortController | null = null;

  constructor(options: HttpChatTransportInitOptions<UIMessage>) {
    const reconnectSignal: { current: AbortSignal | null } = { current: null };
    super({
      ...options,
      // The SDK calls fetch without a signal only for the reconnect, so the
      // reconnect's signal is attached here. Aborting it also errors the
      // response body, which ends a replay that hangs mid-stream.
      fetch: (input, init) => {
        const baseFetch = options.fetch ?? globalThis.fetch;
        if (init?.signal || !reconnectSignal.current) {
          return baseFetch(input, init);
        }
        return baseFetch(input, { ...init, signal: reconnectSignal.current });
      },
    });
    this.reconnectSignal = reconnectSignal;
  }

  async reconnectToStream(
    options: Parameters<
      DefaultChatTransport<UIMessage>["reconnectToStream"]
    >[0],
  ) {
    const controller = new AbortController();
    this.reconnectController = controller;
    this.reconnectSignal.current = controller.signal;
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, RECONNECT_CONNECT_TIMEOUT_MS);
    try {
      return await super.reconnectToStream(options);
    } catch (error) {
      if (timedOut) {
        throw new Error("Timed out reconnecting to the chat response.");
      }
      // Aborted by abortReconnect() before the replay started: there is
      // nothing to resume, which the SDK models as a null stream.
      if (controller.signal.aborted) {
        return null;
      }
      throw error;
    } finally {
      clearTimeout(timeout);
      this.reconnectSignal.current = null;
    }
  }

  /** Ends the current reconnect, whether it is still connecting or streaming. */
  abortReconnect() {
    this.reconnectController?.abort();
    this.reconnectController = null;
  }
}
