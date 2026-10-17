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
