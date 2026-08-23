import { describe, expect, it, vi } from "vitest";
import { runBulkAction } from "./bulk-action";

describe("runBulkAction", () => {
  it("keeps going after a failure and reports both sides", async () => {
    const outcome = await runBulkAction({
      items: ["a", "bad", "c"],
      describe: (item) => item,
      run: async (item) => {
        if (item === "bad") throw new Error("nope");
      },
    });

    expect(outcome.succeeded.sort()).toEqual(["a", "c"]);
    expect(outcome.failed).toEqual([{ label: "bad", error: "nope" }]);
  });

  it("runs every item even when the selection exceeds the concurrency limit", async () => {
    const run = vi.fn().mockResolvedValue(undefined);
    const items = Array.from({ length: 25 }, (_, i) => `item-${i}`);

    const outcome = await runBulkAction({
      items,
      run,
      describe: (item) => item,
      concurrency: 4,
    });

    expect(run).toHaveBeenCalledTimes(25);
    expect(outcome.succeeded).toHaveLength(25);
    expect(outcome.failed).toHaveLength(0);
  });

  it("never runs more than `concurrency` at once", async () => {
    let inFlight = 0;
    let peak = 0;

    await runBulkAction({
      items: Array.from({ length: 12 }, (_, i) => i),
      describe: String,
      concurrency: 3,
      run: async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await Promise.resolve();
        inFlight -= 1;
      },
    });

    expect(peak).toBeLessThanOrEqual(3);
  });

  it("does nothing for an empty selection", async () => {
    const run = vi.fn();
    const outcome = await runBulkAction({ items: [], run, describe: String });

    expect(run).not.toHaveBeenCalled();
    expect(outcome).toEqual({ succeeded: [], failed: [] });
  });
});
