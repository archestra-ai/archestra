import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { expect, test, vi } from "vitest";

// Each case simulates what a shared worker does between files: the previous
// file leaves state behind, then the next file's setup runs.

test("the next file starts with the worker's original timers and fetch", async () => {
  const originalSetTimeout = globalThis.setTimeout;
  const originalFetch = globalThis.fetch;
  globalThis.setTimeout = ((...args: Parameters<typeof setTimeout>) =>
    originalSetTimeout(...args)) as typeof setTimeout;
  globalThis.fetch = (() =>
    Promise.reject(new Error("stale interceptor"))) as typeof fetch;
  try {
    await startNextFile();
    expect(globalThis.setTimeout).toBe(originalSetTimeout);
    expect(globalThis.fetch).toBe(originalFetch);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.fetch = originalFetch;
  }
});

test("the next file can collect what the previous file's mocks hold", async () => {
  const held = holdInMock();
  await startNextFile();
  expect(await isCollected(held)).toBe(true);
});

test("the next file can collect what the previous file's fixtures hold", async () => {
  const held = holdInFixture();
  await startNextFile();
  expect(await isCollected(held)).toBe(true);
});

// ===

async function startNextFile(): Promise<void> {
  vi.resetModules();
  await import("./worker-globals");
}

function holdInMock(): WeakRef<object> {
  const payload = { file: "previous" };
  vi.fn(() => payload)();
  return new WeakRef(payload);
}

function holdInFixture(): WeakRef<object> {
  const payload = { file: "previous" };
  test.extend<{ payload: object }>({
    // biome-ignore lint/correctness/noEmptyPattern: Vitest requires a destructured first parameter.
    payload: async ({}, use) => use(payload),
  });
  return new WeakRef(payload);
}

async function isCollected(ref: WeakRef<object>): Promise<boolean> {
  // A WeakRef read keeps its target alive until the current job ends.
  await new Promise((resolve) => setImmediate(resolve));
  collectGarbage();
  return ref.deref() === undefined;
}

function collectGarbage(): void {
  setFlagsFromString("--expose-gc");
  (runInNewContext("gc") as () => void)();
}
