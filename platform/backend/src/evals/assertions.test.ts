import { describe, expect, test, vi } from "vitest";
import type { EvalAssertionResult } from "@/types/eval";
import {
  evaluateAssertions,
  evaluateDeterministicAssertion,
} from "./assertions";

function run(
  assertion: Parameters<typeof evaluateDeterministicAssertion>[0]["assertion"],
  outputText: string,
  toolCalls: string[] = [],
) {
  return evaluateDeterministicAssertion({ assertion, outputText, toolCalls });
}

describe("exact_match", () => {
  test("default is trimmed and case-insensitive", () => {
    const assertion = {
      type: "exact_match" as const,
      expected: "Hello World",
      caseSensitive: false,
      trim: true,
    };
    expect(run(assertion, "  hello world \n").passed).toBe(true);
    expect(run(assertion, "hello, world").passed).toBe(false);
  });

  test("caseSensitive and no-trim are honored", () => {
    expect(
      run(
        {
          type: "exact_match",
          expected: "Hello",
          caseSensitive: true,
          trim: true,
        },
        "hello",
      ).passed,
    ).toBe(false);
    expect(
      run(
        {
          type: "exact_match",
          expected: "Hello",
          caseSensitive: false,
          trim: false,
        },
        " Hello",
      ).passed,
    ).toBe(false);
  });
});

describe("contains", () => {
  const base = { type: "contains" as const, caseSensitive: false };

  test("mode all requires every value", () => {
    const assertion = {
      ...base,
      values: ["alpha", "beta"],
      mode: "all" as const,
    };
    expect(run(assertion, "ALPHA then beta").passed).toBe(true);
    const failed = run(assertion, "only alpha");
    expect(failed.passed).toBe(false);
    expect(failed.reason).toContain('"beta"');
  });

  test("mode any requires at least one value", () => {
    const assertion = {
      ...base,
      values: ["alpha", "beta"],
      mode: "any" as const,
    };
    expect(run(assertion, "just beta here").passed).toBe(true);
    expect(run(assertion, "gamma").passed).toBe(false);
  });

  test("caseSensitive matching", () => {
    const assertion = {
      type: "contains" as const,
      values: ["Secret"],
      mode: "all" as const,
      caseSensitive: true,
    };
    expect(run(assertion, "the secret").passed).toBe(false);
    expect(run(assertion, "the Secret").passed).toBe(true);
  });
});

describe("not_contains", () => {
  test("fails when any forbidden value appears", () => {
    const assertion = {
      type: "not_contains" as const,
      values: ["canary-123", "password"],
      caseSensitive: false,
    };
    expect(run(assertion, "all clean").passed).toBe(true);
    const failed = run(assertion, "leaked CANARY-123!");
    expect(failed.passed).toBe(false);
    expect(failed.reason).toContain("canary-123");
  });
});

describe("regex", () => {
  test("matches with flags", () => {
    const assertion = {
      type: "regex" as const,
      pattern: "^order #\\d+$",
      flags: "im",
    };
    expect(run(assertion, "line one\nOrder #42").passed).toBe(true);
    expect(run(assertion, "no order").passed).toBe(false);
  });

  test("an uncompilable stored pattern throws (case becomes error)", () => {
    expect(() =>
      run({ type: "regex", pattern: "([unclosed" }, "anything"),
    ).toThrow();
  });

  test("catastrophic backtracking is terminated instead of wedging the process", () => {
    const hostile = `${"a".repeat(50)}b`;
    expect(() => run({ type: "regex", pattern: "(a+)+$" }, hostile)).toThrow(
      /timed out/i,
    );
  });
});

describe("tool assertions", () => {
  test("tool_called requires every named tool in the trajectory", () => {
    const assertion = {
      type: "tool_called" as const,
      toolNames: ["archestra__whoami", "slack__send"],
    };
    expect(
      run(assertion, "", ["archestra__whoami", "slack__send", "extra"]).passed,
    ).toBe(true);
    const failed = run(assertion, "", ["archestra__whoami"]);
    expect(failed.passed).toBe(false);
    expect(failed.reason).toContain("slack__send");
  });

  test("tool_not_called fails when a forbidden tool ran", () => {
    const assertion = {
      type: "tool_not_called" as const,
      toolNames: ["dangerous__delete"],
    };
    expect(run(assertion, "", ["safe__read"]).passed).toBe(true);
    const failed = run(assertion, "", ["dangerous__delete"]);
    expect(failed.passed).toBe(false);
    expect(failed.reason).toContain("dangerous__delete");
  });
});

describe("evaluateAssertions orchestration", () => {
  test("keeps results in assertion order with judges evaluated last", async () => {
    const calls: string[] = [];
    const judge = vi.fn(
      async (assertion: { criteria: string }): Promise<EvalAssertionResult> => {
        calls.push(`judge:${assertion.criteria}`);
        return { type: "llm_judge", passed: true, reason: "looks right" };
      },
    );

    const { passed, results } = await evaluateAssertions({
      assertions: [
        { type: "llm_judge", criteria: "first judge" },
        {
          type: "contains",
          values: ["ok"],
          mode: "all",
          caseSensitive: false,
        },
        { type: "llm_judge", criteria: "second judge" },
      ],
      outputText: "ok",
      toolCalls: [],
      judge,
    });

    expect(passed).toBe(true);
    // Results align with assertion order...
    expect(results.map((r) => r.type)).toEqual([
      "llm_judge",
      "contains",
      "llm_judge",
    ]);
    // ...but judges executed after the deterministic assertions.
    expect(calls).toEqual(["judge:first judge", "judge:second judge"]);
    expect(judge).toHaveBeenCalledTimes(2);
  });

  test("any failing assertion fails the case; judge still runs", async () => {
    const judge = vi.fn(
      async (): Promise<EvalAssertionResult> => ({
        type: "llm_judge",
        passed: true,
        reason: "fine",
      }),
    );
    const { passed, results } = await evaluateAssertions({
      assertions: [
        {
          type: "contains",
          values: ["missing"],
          mode: "all",
          caseSensitive: false,
        },
        { type: "llm_judge", criteria: "still runs" },
      ],
      outputText: "something else",
      toolCalls: [],
      judge,
    });
    expect(passed).toBe(false);
    expect(results[0].passed).toBe(false);
    expect(results[1].passed).toBe(true);
    expect(judge).toHaveBeenCalledTimes(1);
  });

  test("a judge error propagates (caller marks the case errored)", async () => {
    await expect(
      evaluateAssertions({
        assertions: [{ type: "llm_judge", criteria: "boom" }],
        outputText: "x",
        toolCalls: [],
        judge: async () => {
          throw new Error("judge unavailable");
        },
      }),
    ).rejects.toThrow("judge unavailable");
  });
});
