import { describe, expect, test } from "vitest";
import { retryWhilePolicyMoved } from "./policy-moved";

const POLICY_MOVED =
  "OpenAPPA published a newer policy revision for this organization; retry the request";

/** The binding's report that the policy moved, as its loader hands it over. */
function policyMoved(): Error {
  return Object.assign(new Error(POLICY_MOVED), { code: "policy_moved" });
}

describe("retryWhilePolicyMoved", () => {
  test("retries a moved policy and returns what the retry decided", async () => {
    const attempts: number[] = [];
    const decided = await retryWhilePolicyMoved({
      random: () => 0,
      run: async (attempt) => {
        attempts.push(attempt);
        if (attempt === 0) throw policyMoved();
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
          throw policyMoved();
        },
      }),
    ).rejects.toThrow(POLICY_MOVED);
    expect(attempts).toBe(3);
  });

  test("retries a failure the binding codes as policy_moved, whatever its text", async () => {
    let attempts = 0;
    const decided = await retryWhilePolicyMoved({
      random: () => 0,
      run: async () => {
        attempts++;
        if (attempts === 1)
          throw Object.assign(new Error("moved"), { code: "policy_moved" });
        return "allow_call";
      },
    });

    expect(decided).toBe("allow_call");
    expect(attempts).toBe(2);
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
          throw policyMoved();
        },
      }),
    ).rejects.toThrow(POLICY_MOVED);
    const [first, second] = [started[1] - started[0], started[2] - started[1]];
    expect(first).toBeGreaterThanOrEqual(45);
    expect(second).toBeGreaterThanOrEqual(95);
    expect(second).toBeLessThan(500);
  });

  test("starts no attempt past the deadline when a wait overruns it", async () => {
    // The clock reads 0 until the first wait, which overruns the two-second
    // deadline, as a timer can on a loaded event loop.
    let clock = 0;
    let attempts = 0;
    await expect(
      retryWhilePolicyMoved({
        random: () => 0.5,
        now: () => clock,
        sleep: async () => {
          clock += 5_000;
        },
        run: async () => {
          attempts++;
          throw policyMoved();
        },
      }),
    ).rejects.toThrow(POLICY_MOVED);
    expect(attempts).toBe(1);
  });
});
