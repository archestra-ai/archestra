import { describe, expect, it, vi } from "vitest";

describe("appInteractive", () => {
  it("holds deferred work until the first commit is marked, not until window load", async () => {
    vi.resetModules();
    const { appInteractive } = await import("./app-interactive");
    const started = vi.fn();
    void appInteractive.whenIdle().then(started);

    // Scripts finishing loading is not hydration finishing.
    window.dispatchEvent(new Event("load"));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(started).not.toHaveBeenCalled();

    appInteractive.mark();
    await vi.waitFor(() => expect(started).toHaveBeenCalledTimes(1));
  });
});

describe("appInteractive.whenIdle", () => {
  it("releases waiting work one item per idle callback", async () => {
    vi.resetModules();
    vi.useFakeTimers();
    try {
      const { appInteractive } = await import("./app-interactive");
      const order: string[] = [];
      void appInteractive.whenIdle().then(() => order.push("first"));
      void appInteractive.whenIdle().then(() => order.push("second"));
      appInteractive.mark();

      // jsdom has no requestIdleCallback: each idle period is a 50 ms timer.
      await vi.advanceTimersByTimeAsync(50);
      expect(order).toEqual(["first"]);
      await vi.advanceTimersByTimeAsync(50);
      expect(order).toEqual(["first", "second"]);
    } finally {
      vi.useRealTimers();
    }
  });
});
