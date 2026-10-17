import { describe, expect, test } from "vitest";
import { retryWhilePolicyMoved } from "./policy-moved";

const POLICY_MOVED =
  "OpenAPPA published a newer policy revision for this organization; retry the request";

describe("retryWhilePolicyMoved", () => {
  test("retries a moved policy and returns what the retry decided", async () => {
    const attempts: number[] = [];
    const decided = await retryWhilePolicyMoved({
      random: () => 0,
      run: async (attempt) => {
        attempts.push(attempt);
        if (attempt === 0) throw new Error(POLICY_MOVED);
        return "allow_call";
      },
    });

    expect(decided).toBe("allow_call");
    expect(attempts).toEqual([0, 1]);
  });

  test("gives up after a bounded number of attempts with the moved policy", async () => {
    let attempts = 0;
    await expect(
      retryWhilePolicyMoved({
        random: () => 0,
        run: async () => {
          attempts++;
          throw new Error(POLICY_MOVED);
        },
      }),
    ).rejects.toThrow(POLICY_MOVED);
    expect(attempts).toBe(3);
  });

  test("never retries any other failure", async () => {
    let attempts = 0;
    await expect(
      retryWhilePolicyMoved({
        random: () => 0,
        run: async () => {
          attempts++;
          throw new Error(
            "OpenAPPA lost its lease on this operation; retry the request",
          );
        },
      }),
    ).rejects.toThrow(/lost its lease/);
    expect(attempts).toBe(1);
  });

  test("waits a jittered, growing time between attempts", async () => {
    const started: number[] = [];
    await expect(
      retryWhilePolicyMoved({
        random: () => 0.999,
        run: async () => {
          started.push(Date.now());
          throw new Error(POLICY_MOVED);
        },
      }),
    ).rejects.toThrow(POLICY_MOVED);
    const [first, second] = [started[1] - started[0], started[2] - started[1]];
    expect(first).toBeGreaterThanOrEqual(45);
    expect(second).toBeGreaterThanOrEqual(95);
    expect(second).toBeLessThan(500);
  });
});
