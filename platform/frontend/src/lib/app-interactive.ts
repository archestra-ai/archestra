/**
 * The moment the first screen takes input: the chat composer has committed
 * and hydrated, or — on a page without one — the window has loaded.
 *
 * Work nobody is waiting for (error reporting, product analytics) starts
 * after it, on the next idle callback, so it never competes with the first
 * useful render for the main thread or the network.
 */
class AppInteractive {
  private marked = false;
  private readonly listeners: Array<() => void> = [];

  constructor() {
    if (typeof window === "undefined") return;
    if (document.readyState === "complete") {
      queueMicrotask(() => this.mark());
    } else {
      window.addEventListener("load", () => this.mark(), { once: true });
    }
  }

  /** Called by the composer once it has hydrated. Idempotent. */
  mark(): void {
    if (this.marked) return;
    this.marked = true;
    for (const listener of this.listeners.splice(0)) listener();
  }

  /** Resolves on the first idle period after the app became interactive. */
  whenIdle(): Promise<void> {
    return new Promise((resolve) => {
      const onInteractive = () => scheduleIdle(resolve);
      if (this.marked) onInteractive();
      else this.listeners.push(onInteractive);
    });
  }
}

export const appInteractive = new AppInteractive();

// ===

/** Longest an idle callback may wait while the main thread stays busy. */
const IDLE_TIMEOUT_MS = 1_500;

function scheduleIdle(callback: () => void) {
  if (typeof window.requestIdleCallback === "function") {
    window.requestIdleCallback(() => callback(), { timeout: IDLE_TIMEOUT_MS });
  } else {
    setTimeout(callback, 50);
  }
}
