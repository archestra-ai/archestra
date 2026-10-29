import type { PostHog, PostHogConfig } from "posthog-js";
import { appInteractive } from "./app-interactive";

/**
 * Product analytics, started after the app is interactive.
 *
 * `posthog-js` used to be imported by the root layout's provider, which put
 * its ~180 KB ahead of the chat composer on every page. Calls now go through
 * this queue: they are kept until `init` has loaded and initialized PostHog
 * (on the first idle callback after the composer hydrates), then replayed in
 * order — identify, registered properties and early captures included. When
 * the deployment has analytics off, `disable` drops the queue and later calls
 * are ignored, as before.
 */
class PostHogClient {
  private posthog: PostHog | null = null;
  private state: "idle" | "loading" | "ready" | "off" = "idle";
  private queue: Array<(posthog: PostHog) => void> = [];

  init(key: string, config: Partial<PostHogConfig>): void {
    if (this.state !== "idle") return;
    this.state = "loading";
    void appInteractive
      .whenIdle()
      .then(() => import("posthog-js"))
      .then(({ default: posthog }) => {
        posthog.init(key, config);
        this.posthog = posthog;
        this.state = "ready";
        for (const call of this.queue.splice(0)) call(posthog);
      })
      .catch(() => this.disable());
  }

  /** Analytics is off for this deployment: forget queued calls. */
  disable(): void {
    if (this.state === "ready") return;
    this.state = "off";
    this.queue = [];
  }

  /** Run `call` against PostHog now, or once it has initialized. */
  run(call: (posthog: PostHog) => void): void {
    if (this.state === "ready" && this.posthog) {
      call(this.posthog);
      return;
    }
    if (this.state === "off") return;
    if (this.queue.length >= MAX_QUEUED) this.queue.shift();
    this.queue.push(call);
  }

  capture(event: string, properties?: Record<string, unknown>): void {
    this.run((posthog) => posthog.capture(event, properties));
  }
}

/** Calls kept before init; the oldest go first. */
const MAX_QUEUED = 100;

export const posthogClient = new PostHogClient();
