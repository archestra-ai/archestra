import { describe, expect, test } from "@/test";
import { mapWithConcurrency } from "./concurrency";

describe("mapWithConcurrency", () => {
  test("preserves item order and captures per-item rejections", async () => {
    const results = await mapWithConcurrency([1, 2, 3], 2, async (n) => {
      if (n === 2) throw new Error("nope");
      return n * 10;
    });

    expect(results).toEqual([
      { status: "fulfilled", value: 10 },
      { status: "rejected", reason: new Error("nope") },
      { status: "fulfilled", value: 30 },
    ]);
  });

  test("never runs more than `limit` items at once", async () => {
    let inFlight = 0;
    let maxInFlight = 0;

    await mapWithConcurrency(
      Array.from({ length: 10 }, (_, i) => i),
      3,
      () => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        return new Promise<void>((resolve) =>
          setTimeout(() => {
            inFlight--;
            resolve();
          }, 5),
        );
      },
    );

    expect(maxInFlight).toBe(3);
  });
});
