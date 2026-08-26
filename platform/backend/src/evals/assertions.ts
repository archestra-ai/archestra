import { runInNewContext } from "node:vm";
import type { EvalAssertion, EvalAssertionResult } from "@/types/eval";

/**
 * Evaluate every assertion of a case against the agent's output. Deterministic
 * assertions run first (pure, in order); `llm_judge` assertions run last via
 * the injected `judge` boundary so callers control the LLM call (and tests can
 * fake it). All assertions are always evaluated — a failing deterministic
 * assertion does not skip the judge, so the per-assertion report is complete.
 */
export async function evaluateAssertions(params: {
  assertions: EvalAssertion[];
  outputText: string;
  toolCalls: string[];
  judge: (assertion: {
    criteria: string;
    expected?: string;
  }) => Promise<EvalAssertionResult>;
}): Promise<{ passed: boolean; results: EvalAssertionResult[] }> {
  const results: EvalAssertionResult[] = [];

  const judgeAssertions: Array<Extract<EvalAssertion, { type: "llm_judge" }>> =
    [];
  const judgeSlots: number[] = [];

  for (const assertion of params.assertions) {
    if (assertion.type === "llm_judge") {
      // Placeholder keeps `results` aligned with the assertion order.
      judgeSlots.push(results.length);
      judgeAssertions.push(assertion);
      results.push({ type: "llm_judge", passed: false, reason: "" });
      continue;
    }
    results.push(
      evaluateDeterministicAssertion({
        assertion,
        outputText: params.outputText,
        toolCalls: params.toolCalls,
      }),
    );
  }

  for (let i = 0; i < judgeAssertions.length; i++) {
    results[judgeSlots[i]] = await params.judge(judgeAssertions[i]);
  }

  return { passed: results.every((r) => r.passed), results };
}

/**
 * Evaluate a single non-judge assertion. Pure.
 * @public — unit-tested directly; runtime callers go through evaluateAssertions
 */
export function evaluateDeterministicAssertion(params: {
  assertion: Exclude<EvalAssertion, { type: "llm_judge" }>;
  outputText: string;
  toolCalls: string[];
}): EvalAssertionResult {
  const { assertion, outputText, toolCalls } = params;

  switch (assertion.type) {
    case "exact_match": {
      const normalize = (value: string) => {
        let v = assertion.trim ? value.trim() : value;
        if (!assertion.caseSensitive) v = v.toLowerCase();
        return v;
      };
      const passed = normalize(outputText) === normalize(assertion.expected);
      return {
        type: assertion.type,
        passed,
        reason: passed
          ? "output matches the expected text"
          : `output does not equal the expected text ${JSON.stringify(assertion.expected)}`,
      };
    }

    case "contains": {
      const haystack = assertion.caseSensitive
        ? outputText
        : outputText.toLowerCase();
      const hit = (value: string) =>
        haystack.includes(
          assertion.caseSensitive ? value : value.toLowerCase(),
        );
      const missing = assertion.values.filter((value) => !hit(value));
      const found = assertion.values.filter(hit);
      const passed =
        assertion.mode === "any" ? found.length > 0 : missing.length === 0;
      return {
        type: assertion.type,
        passed,
        reason: passed
          ? `output contains ${assertion.mode === "any" ? "at least one of" : "all of"}: ${found.map((v) => JSON.stringify(v)).join(", ")}`
          : assertion.mode === "any"
            ? `output contains none of: ${assertion.values.map((v) => JSON.stringify(v)).join(", ")}`
            : `output is missing: ${missing.map((v) => JSON.stringify(v)).join(", ")}`,
      };
    }

    case "not_contains": {
      const haystack = assertion.caseSensitive
        ? outputText
        : outputText.toLowerCase();
      const present = assertion.values.filter((value) =>
        haystack.includes(
          assertion.caseSensitive ? value : value.toLowerCase(),
        ),
      );
      const passed = present.length === 0;
      return {
        type: assertion.type,
        passed,
        reason: passed
          ? "output contains none of the forbidden values"
          : `output contains forbidden value(s): ${present.map((v) => JSON.stringify(v)).join(", ")}`,
      };
    }

    case "regex": {
      // Pattern validity is enforced at case-write time; a stored pattern that
      // no longer compiles (engine drift) surfaces as a thrown error and the
      // case is marked errored, not silently passed.
      const regex = new RegExp(assertion.pattern, assertion.flags);
      const passed = safeRegexTest(regex, outputText);
      return {
        type: assertion.type,
        passed,
        reason: passed
          ? `output matches /${assertion.pattern}/${assertion.flags ?? ""}`
          : `output does not match /${assertion.pattern}/${assertion.flags ?? ""}`,
      };
    }

    case "tool_called": {
      const missing = assertion.toolNames.filter(
        (name) => !toolCalls.includes(name),
      );
      const passed = missing.length === 0;
      return {
        type: assertion.type,
        passed,
        reason: passed
          ? `agent called: ${assertion.toolNames.join(", ")}`
          : `agent did not call: ${missing.join(", ")} (called: ${toolCalls.length > 0 ? toolCalls.join(", ") : "no tools"})`,
      };
    }

    case "tool_not_called": {
      const called = assertion.toolNames.filter((name) =>
        toolCalls.includes(name),
      );
      const passed = called.length === 0;
      return {
        type: assertion.type,
        passed,
        reason: passed
          ? "agent called none of the forbidden tools"
          : `agent called forbidden tool(s): ${called.join(", ")}`,
      };
    }

    default: {
      // Exhaustiveness: a new assertion type must be handled here.
      const unhandled: never = assertion;
      throw new Error(
        `Unhandled assertion type: ${(unhandled as { type: string }).type}`,
      );
    }
  }
}

/**
 * `regex.test` runs synchronously on the shared event loop, and write-time
 * validation only proves the pattern compiles — a catastrophically
 * backtracking one (e.g. `(a+)+$`) against a long agent output would wedge
 * the whole multi-tenant process, and no abort timer could fire because the
 * blocked loop cannot run its own callbacks. Executing inside a vm script
 * with a timeout lets V8 terminate a runaway evaluation; the throw marks the
 * case errored and the run continues.
 */
const REGEX_EVAL_TIMEOUT_MS = 2_000;

function safeRegexTest(regex: RegExp, text: string): boolean {
  return runInNewContext(
    "regex.test(text)",
    { regex, text },
    { timeout: REGEX_EVAL_TIMEOUT_MS },
  );
}
