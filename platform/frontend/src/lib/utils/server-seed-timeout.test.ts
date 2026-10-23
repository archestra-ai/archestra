import { afterEach, describe, expect, it, vi } from "vitest";
import { withServerSeedDeadline } from "./server-seed-timeout";

describe("withServerSeedDeadline", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("gives up on a read that never answers, and cancels it", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const pending = withServerSeedDeadline((s) => {
      signal = s;
      return new Promise<never>(() => {});
    });
    const outcome = pending.then(
      () => "answered",
      () => "gave up",
    );

    await vi.advanceTimersByTimeAsync(2_000);

    expect(await outcome).toBe("gave up");
    expect(signal?.aborted).toBe(true);
  });

  it("returns a read that answers in time", async () => {
    expect(await withServerSeedDeadline(async () => "rows")).toBe("rows");
  });
});
