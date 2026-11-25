import { AsyncLocalStorage } from "node:async_hooks";
import { describe, expect, test } from "vitest";
import { ConnectionLimiter } from "./connection-limiter";

describe("ConnectionLimiter", () => {
  test("runs at most the limit at once and queues the rest in order", async () => {
    const limiter = new ConnectionLimiter();
    let active = 0;
    let peak = 0;
    const order: number[] = [];
    const releases: (() => void)[] = [];
    const calls = [1, 2, 3, 4].map((id) =>
      limiter.runWithLimit("server", 2, async () => {
        active++;
        peak = Math.max(peak, active);
        await new Promise<void>((resolve) => releases.push(resolve));
        order.push(id);
        active--;
        return id;
      }),
    );

    for (let released = 0; released < 4; released++) {
      await expect.poll(() => releases.length).toBeGreaterThan(released);
      releases[released]();
    }

    expect(await Promise.all(calls)).toEqual([1, 2, 3, 4]);
    expect(order).toEqual([1, 2, 3, 4]);
    expect(peak).toBe(2);
  });

  test("a queued call keeps its caller's async context", async () => {
    const limiter = new ConnectionLimiter();
    const request = new AsyncLocalStorage<string>();
    let releaseFirst = () => {};

    const first = request.run("first", () =>
      limiter.runWithLimit("server", 1, async () => {
        await new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
        return request.getStore();
      }),
    );
    // Queued behind the first call, it starts when the first one finishes.
    const second = request.run("second", () =>
      limiter.runWithLimit("server", 1, async () => request.getStore()),
    );
    await expect.poll(() => releaseFirst).not.toBe(undefined);
    releaseFirst();

    expect(await first).toBe("first");
    expect(await second).toBe("second");
  });

  test("tells a call that it waits, and again when it starts; a call that starts at once hears nothing", async () => {
    const limiter = new ConnectionLimiter();
    const events: string[] = [];
    let releaseFirst = () => {};

    const first = limiter.runWithLimit(
      "server",
      1,
      () =>
        new Promise<void>((resolve) => {
          releaseFirst = resolve;
        }),
      (queued) => events.push(`first ${queued ? "queued" : "started"}`),
    );
    const second = limiter.runWithLimit(
      "server",
      1,
      async () => {
        events.push("second runs");
      },
      (queued) => events.push(`second ${queued ? "queued" : "started"}`),
    );

    // The second call waits behind the first, and says so before it runs.
    await expect.poll(() => events).toEqual(["second queued"]);
    releaseFirst();
    await Promise.all([first, second]);

    expect(events).toEqual(["second queued", "second started", "second runs"]);
  });

  test("a reporting callback that throws does not stop the queue", async () => {
    const limiter = new ConnectionLimiter();
    let releaseFirst: (() => void) | undefined;
    const first = limiter.runWithLimit(
      "server",
      1,
      () =>
        new Promise<void>((resolve) => {
          releaseFirst = resolve;
        }),
    );
    const second = limiter.runWithLimit(
      "server",
      1,
      async () => "ran",
      () => {
        throw new Error("the chat stream is closed");
      },
    );

    await expect.poll(() => releaseFirst).toBeDefined();
    releaseFirst?.();
    await first;

    expect(await second).toBe("ran");
  });
});
