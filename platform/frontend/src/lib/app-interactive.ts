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
  private readonly waiting: Array<() => void> = [];
  private draining = false;

  /** Called once the first commit has happened. Idempotent. */
  mark(): void {
    if (this.marked) return;
    this.marked = true;
    this.drain();
  }

  /**
   * Resolves on an idle period after the app became interactive. Waiting
   * work is released one item per idle callback, never all at once: each item
   * typically loads and evaluates a chunk, and a burst of them would hold the
   * main thread against the first keystrokes.
   */
  whenIdle(): Promise<void> {
    return new Promise((resolve) => {
      this.waiting.push(resolve);
      if (this.marked) this.drain();
    });
  }

  private drain(): void {
    if (this.draining || this.waiting.length === 0) return;
    this.draining = true;
    scheduleIdle(() => {
      this.draining = false;
      this.waiting.shift()?.();
      this.drain();
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
  // A hidden tab paints nothing and pauses animation frames until it is shown,
  // so waiting for a frame there would hold the work (and every request it
  // starts) until someone switches to the tab. There is no paint to protect.
  if (document.visibilityState === "hidden") {
    setTimeout(callback, 0);
    return;
  }
  requestAnimationFrame(() => setTimeout(callback, 0));
}
