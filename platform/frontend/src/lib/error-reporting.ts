import {
  getFrontendBrowserSentryOptions,
  shouldEnableFrontendTelemetry,
} from "../../sentry.shared";
import { appInteractive } from "./app-interactive";

type Sentry = typeof import("@sentry/nextjs");
type SentryUser = Parameters<Sentry["setUser"]>[0];
type CaptureContext = Parameters<Sentry["captureException"]>[1];

/**
 * Browser error reporting, started after the app is interactive.
 *
 * `@sentry/nextjs` (with its replay recorder) is a large module graph, and
 * importing it — even lazily — on the first commit put it ahead of the chat
 * composer. Every client call goes through this facade instead. The SDK loads
 * on the first idle callback after the composer hydrates, and only when the
 * deployment enables telemetry.
 *
 * Calls made before then are buffered and replayed into Sentry on init:
 * `setUser`, `captureException` (error boundaries, API failures) and
 * uncaught errors/rejections, which a window listener records until Sentry's
 * own global handlers take over. With telemetry off the buffer is dropped and
 * the SDK is never fetched.
 */
class ErrorReporting {
  private sentry: Sentry | null = null;
  private state: "idle" | "waiting" | "ready" | "off" = "idle";
  private pending: Array<(sentry: Sentry) => void> = [];
  private readonly keyed = new Map<string, (sentry: Sentry) => void>();

  /** Called once from instrumentation-client at boot. */
  start(params: { dsn: string; environment: string | undefined }): void {
    if (this.state !== "idle") return;
    if (!shouldEnableFrontendTelemetry(params)) {
      this.state = "off";
      this.pending = [];
      return;
    }
    this.state = "waiting";
    window.addEventListener("error", this.onWindowError);
    window.addEventListener("unhandledrejection", this.onUnhandledRejection);
    void appInteractive
      .whenIdle()
      .then(() => import("@sentry/nextjs"))
      .then((sentry) => {
        sentry.init(getFrontendBrowserSentryOptions(params));
        window.removeEventListener("error", this.onWindowError);
        window.removeEventListener(
          "unhandledrejection",
          this.onUnhandledRejection,
        );
        this.sentry = sentry;
        this.state = "ready";
        for (const call of this.pending.splice(0)) call(sentry);
      })
      .catch(() => {
        this.state = "off";
        this.pending = [];
      });
  }

  captureException(error: unknown, context?: CaptureContext): void {
    this.run((sentry) => sentry.captureException(error, context));
  }

  setUser(user: SentryUser): void {
    // Only the latest identity matters; drop earlier ones still waiting.
    this.run((sentry) => sentry.setUser(user), "setUser");
  }

  /** Router transitions before init carry no trace to attach to. */
  captureRouterTransitionStart(
    ...args: Parameters<Sentry["captureRouterTransitionStart"]>
  ): void {
    this.sentry?.captureRouterTransitionStart(...args);
  }

  // ===

  private readonly onWindowError = (event: ErrorEvent) => {
    this.captureException(event.error ?? event.message);
  };

  private readonly onUnhandledRejection = (event: PromiseRejectionEvent) => {
    this.captureException(event.reason);
  };

  private run(call: (sentry: Sentry) => void, key?: string): void {
    if (this.state === "ready" && this.sentry) {
      call(this.sentry);
      return;
    }
    if (this.state === "off") return;
    if (key) {
      const previous = this.keyed.get(key);
      if (previous) this.pending = this.pending.filter((c) => c !== previous);
      this.keyed.set(key, call);
    }
    if (this.pending.length >= MAX_PENDING) this.pending.shift();
    this.pending.push(call);
  }
}

/** Errors kept while the SDK has not loaded; the oldest go first. */
const MAX_PENDING = 50;

export const errorReporting = new ErrorReporting();
