import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SteerQueue } from "./steer-queue.js";

/**
 * Exercised against a real file on disk. A FIFO and a regular file behave the
 * same for the reader's line-splitting and reopen logic, which is the part
 * worth pinning; named-pipe semantics belong to the kernel.
 */
async function withQueue(
  contents: string,
  assertion: (queue: SteerQueue) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), "steer-"));
  const file = path.join(dir, "steer");
  await writeFile(file, contents, "utf8");
  const queue = new SteerQueue(file, () => undefined);
  queue.start();
  try {
    await assertion(queue);
  } finally {
    queue.stop();
    await rm(dir, { recursive: true, force: true });
  }
}

describe("SteerQueue", () => {
  it("delivers one message per line, in order", async () => {
    await withQueue("first message\nsecond message\n", async (queue) => {
      const delivered = await queue.waitForMessage();
      // A steer is atomic per line: two messages must never merge into one.
      expect(delivered.slice(0, 2)).toEqual([
        "first message",
        "second message",
      ]);
    });
  });

  it("ignores blank lines so a stray newline is not an empty turn", async () => {
    await withQueue("\n   \nreal message\n", async (queue) => {
      expect(await queue.waitForMessage()).toContain("real message");
    });
  });

  it("drain empties the queue so a message is never delivered twice", async () => {
    await withQueue("only message\n", async (queue) => {
      await queue.waitForMessage();
      expect(queue.hasPending).toBe(false);
      expect(queue.drain()).toEqual([]);
    });
  });

  it("merges attached-terminal lines into the same ordered turn queue", async () => {
    await withQueue("from fifo\n", async (queue) => {
      await queue.waitForMessage();
      queue.enqueue("  from terminal  ");
      expect(queue.drain()).toEqual(["from terminal"]);
    });
  });

  it("stops waiting once the queue is stopped", async () => {
    await withQueue("", async (queue) => {
      queue.stop();
      expect(await queue.waitForMessage()).toEqual([]);
    });
  });

  it("returns an empty batch when the idle timeout expires", async () => {
    await withQueue("", async (queue) => {
      expect(await queue.waitForMessage(1)).toEqual([]);
    });
  });
});
