/**
 * The moment the first screen takes input: the app's first commit — on the
 * chat pages, the one that hydrates the server-rendered composer — has
 * happened (AppInteractiveMarker in the root layout marks it).
 *
 * Work nobody is waiting for (error reporting, product analytics, chunks
 * preloaded for later) starts after it, on the next idle callback, so it never
 * competes with hydration for the main thread. The window `load` event is not
 * a substitute: it fires once the page's scripts have loaded, which can be
 * well before React has finished hydrating them.
 */
class AppInteractive {
  private marked = false;
  private readonly listeners: Array<() => void> = [];

  /** Called once the first commit has happened. Idempotent. */
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

/**
 * Run `callback` once the frame being committed now has been painted, so a
 * just-hydrated screen shows (and takes input) before the work starts.
 */
export function afterNextPaint(callback: () => void): void {
  requestAnimationFrame(() => setTimeout(callback, 0));
}
