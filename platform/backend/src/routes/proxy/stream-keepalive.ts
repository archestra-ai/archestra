import type { ServerResponse } from "node:http";

/**
 * Keep-alive frame written to an idle `text/event-stream` response. A
 * `:`-prefixed line is a comment under the event-stream spec, so a compliant
 * SSE parser drops it without touching message content — which is also why it
 * is only safe on `text/event-stream`, not on the NDJSON or binary event
 * streams some providers speak.
 */
export const STREAM_KEEPALIVE_SSE_COMMENT = ": archestra keep-alive\n\n";

/**
 * Keeps bytes flowing on an SSE response the proxy has committed but is not
 * currently writing to.
 *
 * The proxy withholds client tool-call events until the turn has fully
 * streamed and tool-invocation policy has run, so a large tool payload
 * generated token-by-token is, from the client's side, a silent stream for
 * that whole stretch. Streaming clients run byte-clock watchdogs against
 * exactly that (Claude Code flags a stall after ~20s and aborts after a few
 * minutes), and the upstream `ping` events that would otherwise cover it never
 * reach us: the Anthropic SDK drops them inside its SSE parser.
 *
 * This never commits headers. Writing anything before the upstream call has
 * produced a byte would force a 200 and foreclose the provider's real status
 * (a 429, an overload 529, a 400) that clients key their retry logic on. It
 * only fires on a stream that is already open and has been quiet for the
 * configured interval; every real write is reported through {@link touch} so
 * an active stream is never interrupted.
 */
export class StreamKeepAlive {
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly raw: Pick<
      ServerResponse,
      "headersSent" | "writableEnded" | "destroyed" | "write"
    >,
    /** Silence tolerated before a keep-alive is written. `0` disables. */
    private readonly intervalMs: number,
    /** Whether the response is `text/event-stream`; nothing else can carry a comment. */
    private readonly isEventStream: boolean,
  ) {}

  /** Arm the idle timer. A disabled or non-SSE keep-alive stays inert. */
  start(): void {
    if (this.timer || this.intervalMs <= 0 || !this.isEventStream) {
      return;
    }
    this.timer = setTimeout(() => this.onIdle(), this.intervalMs);
    this.timer.unref();
  }

  /** Report that a real byte just went out, so the idle clock restarts. */
  touch(): void {
    this.timer?.refresh();
  }

  stop(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  private onIdle(): void {
    if (!this.timer) {
      return;
    }
    if (
      this.raw.headersSent &&
      !this.raw.writableEnded &&
      !this.raw.destroyed
    ) {
      this.raw.write(STREAM_KEEPALIVE_SSE_COMMENT);
    }
    this.timer.refresh();
  }
}
