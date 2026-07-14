import { describe, expect, test } from "@/test";
import { __test } from "./chat-tool-builder";

const { executeAtMostOnce } = __test;

/**
 * Regression coverage for the require_approval double-execution bug: the same
 * pending-approval turn approved in two tabs must dispatch the external MCP
 * call at most once. `executeAtMostOnce` is the guard that enforces it, keyed
 * on the AI SDK tool call id.
 */
describe("executeAtMostOnce", () => {
  test("two concurrent approvals of the same tool call dispatch only once", async () => {
    let dispatchCount = 0;
    const dispatch = async () => {
      dispatchCount++;
      // Simulate a slow upstream MCP call so both requests overlap.
      await new Promise((resolve) => setTimeout(resolve, 20));
      return { content: `result-${dispatchCount}` };
    };

    const [a, b] = await Promise.all([
      executeAtMostOnce({ toolCallId: "tc_two_tab", enabled: true, dispatch }),
      executeAtMostOnce({ toolCallId: "tc_two_tab", enabled: true, dispatch }),
    ]);

    // Exactly one external execution...
    expect(dispatchCount).toBe(1);
    // ...and both tabs observe the same recorded result.
    expect(a).toEqual({ content: "result-1" });
    expect(b).toEqual({ content: "result-1" });
  });

  test("re-approving an already-resolved tool call does not re-execute", async () => {
    let dispatchCount = 0;
    const dispatch = async () => {
      dispatchCount++;
      return { content: "once" };
    };

    const first = await executeAtMostOnce({
      toolCallId: "tc_repeat",
      enabled: true,
      dispatch,
    });
    const second = await executeAtMostOnce({
      toolCallId: "tc_repeat",
      enabled: true,
      dispatch,
    });

    expect(dispatchCount).toBe(1);
    expect(first).toEqual({ content: "once" });
    expect(second).toEqual({ content: "once" });
  });

  test("read-only (non-approval) tools are not gated and run every time", async () => {
    let dispatchCount = 0;
    const dispatch = async () => {
      dispatchCount++;
      return { content: "read" };
    };

    await executeAtMostOnce({
      toolCallId: "tc_readonly",
      enabled: false,
      dispatch,
    });
    await executeAtMostOnce({
      toolCallId: "tc_readonly",
      enabled: false,
      dispatch,
    });

    expect(dispatchCount).toBe(2);
  });

  test("a missing tool call id falls through to a single normal dispatch", async () => {
    let dispatchCount = 0;
    const dispatch = async () => {
      dispatchCount++;
      return { content: "no-id" };
    };

    const result = await executeAtMostOnce({
      toolCallId: undefined,
      enabled: true,
      dispatch,
    });

    expect(dispatchCount).toBe(1);
    expect(result).toEqual({ content: "no-id" });
  });

  test("a failed execution is recorded once; the concurrent loser sees the error result", async () => {
    let dispatchCount = 0;
    const dispatch = async () => {
      dispatchCount++;
      await new Promise((resolve) => setTimeout(resolve, 20));
      throw new Error("upstream boom");
    };

    const results = await Promise.allSettled([
      executeAtMostOnce({ toolCallId: "tc_fail", enabled: true, dispatch }),
      executeAtMostOnce({ toolCallId: "tc_fail", enabled: true, dispatch }),
    ]);

    // Still only one external dispatch despite the failure.
    expect(dispatchCount).toBe(1);
    // The winner rethrows; the loser resolves with the recorded error result.
    const rejected = results.filter((r) => r.status === "rejected");
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    expect(rejected).toHaveLength(1);
    expect(fulfilled).toHaveLength(1);
    expect((fulfilled[0] as PromiseFulfilledResult<unknown>).value).toEqual({
      error: "upstream boom",
    });
  });
});
