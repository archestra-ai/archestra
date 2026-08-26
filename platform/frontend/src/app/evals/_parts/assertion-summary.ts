import type { EvalAssertion } from "@/lib/evals/eval.query";

/**
 * One plain-English line per assertion, shared by the case table's chips and
 * the case editor's live preview so both read the same language.
 */
export function summarizeAssertion(assertion: EvalAssertion): string {
  switch (assertion.type) {
    case "exact_match":
      return `Answer is exactly “${truncate(assertion.expected)}”`;
    case "contains":
      return assertion.values.length === 1
        ? `Answer contains “${truncate(assertion.values[0])}”`
        : `Answer contains ${assertion.mode === "any" ? "any" : "all"} of ${list(assertion.values)}`;
    case "not_contains":
      return `Answer never mentions ${list(assertion.values)}`;
    case "regex":
      return `Answer matches /${truncate(assertion.pattern)}/${assertion.flags ?? ""}`;
    case "tool_called":
      return assertion.toolNames.length === 1
        ? `Agent calls ${assertion.toolNames[0]}`
        : `Agent calls ${list(assertion.toolNames)}`;
    case "tool_not_called":
      return assertion.toolNames.length === 1
        ? `Agent never calls ${assertion.toolNames[0]}`
        : `Agent never calls ${list(assertion.toolNames)}`;
    case "llm_judge":
      return `Judge: ${truncate(assertion.criteria, 70)}`;
  }
}

// === Internal helpers ===

function truncate(value: string, max = 40): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function list(values: string[], max = 3): string {
  const shown = values.slice(0, max).map((value) => `“${truncate(value, 25)}”`);
  const rest = values.length - max;
  return rest > 0 ? `${shown.join(", ")} +${rest} more` : shown.join(", ");
}
