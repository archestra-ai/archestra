import { describe, expect, test } from "vitest";
import {
  buildHistorySkippedAttachmentsNote,
  buildSkippedAttachmentsNote,
  formatApprovalToolArgs,
  Semaphore,
} from "./utils";

describe("formatApprovalToolArgs", () => {
  test("pretty-prints a non-empty arguments object", () => {
    const out = formatApprovalToolArgs({ repo: "octo/repo", count: 3 });
    expect(out).toBe('{\n  "repo": "octo/repo",\n  "count": 3\n}');
  });

  test("returns null for undefined or empty arguments", () => {
    expect(formatApprovalToolArgs(undefined)).toBeNull();
    expect(formatApprovalToolArgs({})).toBeNull();
  });

  test("truncates output that exceeds the max length", () => {
    const out = formatApprovalToolArgs({ blob: "x".repeat(5000) }, 100);
    expect(out).not.toBeNull();
    // 100 chars of JSON + the truncation marker.
    expect(out?.length).toBe(100 + "\n… (truncated)".length);
    expect(out?.endsWith("\n… (truncated)")).toBe(true);
  });

  test("returns null when arguments cannot be serialized", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(formatApprovalToolArgs(circular)).toBeNull();
  });
});

describe("buildSkippedAttachmentsNote", () => {
  test("returns empty string when nothing was skipped", () => {
    expect(buildSkippedAttachmentsNote([])).toBe("");
  });

  test("names each skipped file so the model knows it existed", () => {
    const note = buildSkippedAttachmentsNote([
      { name: "IMG_0354.png", sizeBytes: 16_562_518, reason: "too_large" },
      { name: "notes.zip", reason: "download_failed" },
    ]);
    expect(note).not.toBe("");
    expect(note).toContain("IMG_0354.png");
    expect(note).toContain("notes.zip");
  });

  test("handles an unnamed file without throwing", () => {
    const note = buildSkippedAttachmentsNote([{ reason: "too_large" }]);
    expect(note).not.toBe("");
  });
});

describe("buildHistorySkippedAttachmentsNote", () => {
  test("returns empty string when nothing was skipped", () => {
    expect(buildHistorySkippedAttachmentsNote([])).toBe("");
  });

  test("names each skipped file so the model knows it existed", () => {
    const note = buildHistorySkippedAttachmentsNote([
      { name: "IMG_0354.png", sizeBytes: 16_562_518, reason: "too_large" },
      { name: "notes.zip", reason: "download_failed" },
    ]);
    expect(note).not.toBe("");
    expect(note).toContain("IMG_0354.png");
    expect(note).toContain("notes.zip");
  });

  test("handles an unnamed file without throwing", () => {
    const note = buildHistorySkippedAttachmentsNote([{ reason: "too_large" }]);
    expect(note).not.toBe("");
  });
});

describe("Semaphore", () => {
  /** Flush the microtask queue so settled promises run their callbacks. */
  const flush = async () => {
    await Promise.resolve();
    await Promise.resolve();
  };

  /** Wrap a promise with a flag that flips once it settles. */
  const track = (promise: Promise<void>) => {
    const state = { settled: false };
    void promise.then(() => {
      state.settled = true;
    });
    return state;
  };

  test("blocks acquires beyond maxConcurrent until a release", async () => {
    const semaphore = new Semaphore(2);
    await semaphore.acquire();
    await semaphore.acquire();

    const third = track(semaphore.acquire());
    await flush();
    expect(third.settled).toBe(false);

    semaphore.release();
    await flush();
    expect(third.settled).toBe(true);
  });

  test("resumes waiters in FIFO order", async () => {
    const semaphore = new Semaphore(1);
    await semaphore.acquire();

    const order: number[] = [];
    void semaphore.acquire().then(() => order.push(1));
    void semaphore.acquire().then(() => order.push(2));

    semaphore.release();
    await flush();
    expect(order).toEqual([1]);

    semaphore.release();
    await flush();
    expect(order).toEqual([1, 2]);
  });

  test("release with no waiters frees a permit for a later acquire", async () => {
    const semaphore = new Semaphore(1);
    await semaphore.acquire();
    semaphore.release();

    // Permit was returned to the pool, so both re-acquire and blocking work.
    await semaphore.acquire();
    const second = track(semaphore.acquire());
    await flush();
    expect(second.settled).toBe(false);
    semaphore.release();
    await flush();
    expect(second.settled).toBe(true);
  });

  test("stays usable after a throwing acquire/release cycle", async () => {
    const semaphore = new Semaphore(1);

    await expect(
      (async () => {
        await semaphore.acquire();
        try {
          throw new Error("boom");
        } finally {
          semaphore.release();
        }
      })(),
    ).rejects.toThrow("boom");

    const next = track(semaphore.acquire());
    await flush();
    expect(next.settled).toBe(true);
  });
});
