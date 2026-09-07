import { mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { SteerQueue } from "./steer-queue.js";

/**
 * Regular files cover line parsing; the subprocess test below separately
 * exercises FIFO shutdown, whose blocking-open behavior differs from files.
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
  it.skipIf(process.platform === "win32")(
    "receives messages from successive FIFO writers",
    async () => {
      const dir = await mkdtemp(path.join(tmpdir(), "steer-fifo-"));
      const fifo = path.join(dir, "steer");
      const errors: unknown[] = [];
      const queue = new SteerQueue(fifo, (error) => errors.push(error));
      try {
        await promisify(execFile)("mkfifo", [fifo]);
        queue.start();
        await writeFile(fifo, "first\nsecond\n");
        expect(await queue.waitForMessage(2000)).toEqual(["first", "second"]);
        await writeFile(fifo, "third\n");
        expect(await queue.waitForMessage(2000)).toEqual(["third"]);
        const writer = await open(fifo, "w");
        try {
          const message = Buffer.from("split 🦞 message\n");
          await writer.write(message.subarray(0, 8));
          expect(await queue.waitForMessage(100)).toEqual([]);
          await writer.write(message.subarray(8));
          expect(await queue.waitForMessage(2000)).toEqual([
            "split 🦞 message",
          ]);
        } finally {
          await writer.close();
        }
        expect(errors).toEqual([]);
      } finally {
        queue.stop();
        await rm(dir, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "exits after stopping a FIFO reader with no writer",
    async () => {
      const dir = await mkdtemp(path.join(tmpdir(), "steer-fifo-"));
      const fifo = path.join(dir, "steer");
      try {
        await promisify(execFile)("mkfifo", [fifo]);
        const source = new URL("./steer-queue.ts", import.meta.url).href;
        const script = `import { SteerQueue } from ${JSON.stringify(source)};
        const queue = new SteerQueue(${JSON.stringify(fifo)}, console.error);
        queue.start();
        setTimeout(() => queue.stop(), 200);`;
        const result = await promisify(execFile)(
          process.execPath,
          ["--import", "tsx", "--input-type=module", "-e", script],
          { timeout: 5000 },
        );
        expect(result.stderr).toBe("");
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  );

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

import { execFile } from "node:child_process";
