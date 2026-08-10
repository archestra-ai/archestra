import { describe, expect, it, vi } from "vitest";
import { createLatestWriteQueue } from "./latest-write-queue";

/** A write whose individual calls are settled by hand, in any order. */
function controllableWrite<T>() {
  const calls: { value: T; resolve: () => void; reject: () => void }[] = [];
  const write = vi.fn(
    (value: T) =>
      new Promise<void>((resolve, reject) => {
        calls.push({
          value,
          resolve: () => resolve(),
          reject: () => reject(new Error("write failed")),
        });
      }),
  );
  return { write, calls };
}

/** Lets the queue's loop react to a settled write and issue the next one. */
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

const valuesWritten = (write: ReturnType<typeof vi.fn>) =>
  write.mock.calls.map(([value]) => value);

describe("createLatestWriteQueue", () => {
  it("never has two writes in flight at once", async () => {
    const { write, calls } = controllableWrite<string>();
    const queue = createLatestWriteQueue(write);

    queue.set("thinking");
    queue.set("flash");
    await flush();

    // The second click must not race the first to the same row.
    expect(write).toHaveBeenCalledTimes(1);
    expect(calls[0].value).toBe("thinking");
  });

  it("writes the last value clicked, after the first settles", async () => {
    const { write, calls } = controllableWrite<string>();
    const queue = createLatestWriteQueue(write);

    queue.set("thinking");
    queue.set("flash");
    calls[0].resolve();
    await flush();

    expect(calls[1].value).toBe("flash");
    calls[1].resolve();
    await queue.pending;

    expect(valuesWritten(write)).toEqual(["thinking", "flash"]);
  });

  it("drops values the user clicked past", async () => {
    const { write, calls } = controllableWrite<string>();
    const queue = createLatestWriteQueue(write);

    queue.set("a");
    queue.set("b");
    queue.set("c");
    calls[0].resolve();
    await flush();
    calls[1].resolve();
    await queue.pending;

    // "b" was superseded before it ever went out.
    expect(valuesWritten(write)).toEqual(["a", "c"]);
  });

  it("still writes the newest value when an earlier write fails", async () => {
    const { write, calls } = controllableWrite<string>();
    const queue = createLatestWriteQueue(write);

    queue.set("thinking");
    queue.set("flash");
    calls[0].reject();
    await flush();

    // A rejected write must not strand the choice the user actually made.
    expect(calls[1].value).toBe("flash");
    calls[1].resolve();
    await expect(queue.pending).resolves.toBeUndefined();
  });

  it("reports idle before the first write and after the last settles", async () => {
    const { write, calls } = controllableWrite<string>();
    const queue = createLatestWriteQueue(write);

    expect(queue.pending).toBeNull();

    queue.set("thinking");
    expect(queue.pending).not.toBeNull();

    calls[0].resolve();
    await queue.pending;
    // A stale non-null pending would make every later send wait on it forever.
    expect(queue.pending).toBeNull();
    expect(write).toHaveBeenCalledTimes(1);
  });

  it("starts a fresh run for a click that arrives after the queue drained", async () => {
    const { write, calls } = controllableWrite<string>();
    const queue = createLatestWriteQueue(write);

    queue.set("thinking");
    calls[0].resolve();
    await queue.pending;

    queue.set("flash");
    expect(write).toHaveBeenCalledTimes(2);
    expect(queue.pending).not.toBeNull();
  });
});
