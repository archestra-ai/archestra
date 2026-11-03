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
 * streamed and the proxy plugins have ruled on its calls, so a large tool payload
 * generated token-by-token is, from the client's side, a silent stream for
 * that whole stretch. Streaming clients run byte-clock watchdogs against
 * exactly that (Claude Code flags a stall after ~20s and aborts after a few
 * minutes), and the upstream `ping` events that would otherwise cover it never
 * reach us: the Anthropic SDK drops them inside its SSE parser.
 *
 * Uncommitted responses can send comments only after {@link allowCommit}:
 * the caller must first observe a successful upstream HTTP response or select
 * a pooled stream. Failures before that retain their HTTP status. Every real
 * write is reported through {@link touch}.
 */
export class StreamKeepAlive {
  private timer: NodeJS.Timeout | undefined;
  private commitAllowed = false;

  constructor(
    private readonly raw: Pick<
      ServerResponse,
      | "headersSent"
      | "writableEnded"
      | "destroyed"
      | "writableNeedDrain"
      | "write"
      | "once"
      | "off"
    >,
    /** Silence tolerated before a keep-alive is written. `0` disables. */
    private readonly intervalMs: number,
    /** Whether the response is `text/event-stream`; nothing else can carry a comment. */
    private readonly isEventStream: boolean,
    private readonly commitHeaders?: () => void,
  ) {}

  private readonly onClose = () => this.stop();

  allowCommit(): void {
    this.commitAllowed = true;
    this.touch();
  }

  /** An attempt failed before its first event; its replacement is pending. */
  suspendCommit(): void {
    this.commitAllowed = false;
  }

  /** Arm the idle timer. A disabled or non-SSE keep-alive stays inert. */
  start(): void {
    if (this.timer || this.intervalMs <= 0 || !this.isEventStream) {
      return;
    }
    this.timer = setTimeout(() => this.onIdle(), this.intervalMs);
    this.timer.unref();
    this.raw.once("close", this.onClose);
    this.raw.once("finish", this.onClose);
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
    this.raw.off("close", this.onClose);
    this.raw.off("finish", this.onClose);
  }

  private onIdle(): void {
    if (!this.timer) {
      return;
    }
    if (this.raw.writableEnded || this.raw.destroyed) {
      this.stop();
      return;
    }
    // A queued byte already keeps the connection busy. Do not accumulate
    // comments behind it while the client cannot drain the socket.
    if (!this.raw.writableNeedDrain) {
      if (!this.raw.headersSent && this.commitAllowed) this.commitHeaders?.();
      if (this.raw.headersSent) this.raw.write(STREAM_KEEPALIVE_SSE_COMMENT);
    }
    this.timer?.refresh();
  }
}
