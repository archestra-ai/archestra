import { ApiError } from "@archestra/shared/types";
import {
  GUARDRAILS_POLICY_MAX_LENGTH,
  type GuardrailsPolicyEdit,
  type GuardrailsPolicyProposal,
} from "@/types/guardrails-policy-proposal";

/**
 * The policy text a proposal stands for. Edits resolve against `current`, the
 * revision the caller already checked against `expectedRevision`. Revisions are
 * immutable, so the same edits and revision always give the same text.
 */
export function resolveProposedPolicy(params: {
  current: { revision: number; content: string };
  proposal: GuardrailsPolicyProposal;
}): string {
  const { content, edits } = params.proposal;
  const hasContent = typeof content === "string" && content.length > 0;
  const hasEdits = Array.isArray(edits) && edits.length > 0;
  if (hasContent && hasEdits)
    throw new ApiError(
      400,
      "Send either edits or content, not both. Use edits to change the current policy, or content for a first policy or a full rewrite.",
    );
  if (hasContent) return content;
  if (!hasEdits)
    throw new ApiError(
      400,
      "Send edits to change the current policy, or content with the complete policy text.",
    );
  return applyPolicyEdits({
    text: params.current.content,
    revision: params.current.revision,
    edits,
  });
}

/**
 * A unified diff (3 lines of context) and its added and removed line counts.
 * No change gives an empty diff.
 */
export function policyDiff(params: {
  before: string;
  after: string;
  path: string;
}): { diff: string; changed: { added: number; removed: number } } {
  const ops = lineDiff(splitLines(params.before), splitLines(params.after));
  let added = 0;
  let removed = 0;
  for (const op of ops) {
    if (op.kind === "+") added++;
    else if (op.kind === "-") removed++;
  }
  if (added + removed === 0)
    return { diff: "", changed: { added: 0, removed: 0 } };
  return {
    diff: `--- a/${params.path}\n+++ b/${params.path}\n${hunks(ops)}`,
    changed: { added, removed },
  };
}

// ===

function applyPolicyEdits(params: {
  text: string;
  revision: number;
  edits: GuardrailsPolicyEdit[];
}): string {
  let text = params.text;
  for (const [index, edit] of params.edits.entries()) {
    const name = `edits[${index}]`;
    if (edit.oldText.length === 0)
      throw new ApiError(
        400,
        `${name}: oldText is empty. Copy the exact text to replace from get_guardrails_policy.`,
      );
    if (edit.oldText === edit.newText)
      throw new ApiError(
        400,
        `${name}: oldText and newText are the same. Remove this edit or change newText.`,
      );
    const parts = text.split(edit.oldText);
    const matches = parts.length - 1;
    if (matches === 0)
      throw new ApiError(
        400,
        `${name}: oldText was not found in the policy at revision ${params.revision}${index > 0 ? " after the earlier edits" : ""}. Copy the exact text from get_guardrails_policy, including whitespace.`,
      );
    if (matches > 1 && !edit.replaceAll)
      throw new ApiError(
        400,
        `${name}: oldText matches ${matches} places. Add surrounding lines to make it unique, or set replaceAll to true.`,
      );
    // join, not String.replace: replace would expand `$&`-style patterns in newText.
    text = parts.join(edit.newText);
  }
  if (text.length === 0)
    throw new ApiError(
      400,
      "The edits leave the policy empty. Send content to replace the whole policy.",
    );
  if (text.length > GUARDRAILS_POLICY_MAX_LENGTH)
    throw new ApiError(
      400,
      `The edited policy is ${text.length} characters, over the ${GUARDRAILS_POLICY_MAX_LENGTH} limit.`,
    );
  return text;
}

const CONTEXT = 3;
// The LCS table covers only the lines between the common prefix and suffix.
// Past this many cells the middle is shown as one replacement hunk instead.
const LCS_CELL_LIMIT = 4_000_000;

type DiffOp = { kind: " " | "-" | "+"; line: string };

/** Lines with their terminators, so a missing final newline is a difference. */
function splitLines(text: string): string[] {
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

function lineDiff(a: string[], b: string[]): DiffOp[] {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const ops: DiffOp[] = [];
  for (let i = 0; i < start; i++) ops.push({ kind: " ", line: a[i] });
  middleDiff(a.slice(start, endA), b.slice(start, endB), ops);
  for (let i = endA; i < a.length; i++) ops.push({ kind: " ", line: a[i] });
  return ops;
}

function middleDiff(a: string[], b: string[], ops: DiffOp[]): void {
  if ((a.length + 1) * (b.length + 1) > LCS_CELL_LIMIT) {
    for (const line of a) ops.push({ kind: "-", line });
    for (const line of b) ops.push({ kind: "+", line });
    return;
  }
  // The shorter side is at most sqrt(LCS_CELL_LIMIT) lines, so every LCS
  // length fits in 16 bits.
  const width = b.length + 1;
  const lcs = new Uint16Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--)
      lcs[i * width + j] =
        a[i] === b[j]
          ? lcs[(i + 1) * width + j + 1] + 1
          : Math.max(lcs[(i + 1) * width + j], lcs[i * width + j + 1]);
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      ops.push({ kind: " ", line: a[i] });
      i++;
      j++;
    } else if (lcs[(i + 1) * width + j] >= lcs[i * width + j + 1])
      ops.push({ kind: "-", line: a[i++] });
    else ops.push({ kind: "+", line: b[j++] });
  }
  while (i < a.length) ops.push({ kind: "-", line: a[i++] });
  while (j < b.length) ops.push({ kind: "+", line: b[j++] });
}

function hunks(ops: DiffOp[]): string {
  const changes: number[] = [];
  for (const [index, op] of ops.entries())
    if (op.kind !== " ") changes.push(index);
  let out = "";
  let cursor = 0;
  let oldLine = 0;
  let newLine = 0;
  let next = 0;
  while (next < changes.length) {
    const first = changes[next];
    let last = first;
    while (
      next + 1 < changes.length &&
      changes[next + 1] - last <= 2 * CONTEXT + 1
    )
      last = changes[++next];
    next++;
    const from = Math.max(0, first - CONTEXT);
    const to = Math.min(ops.length, last + CONTEXT + 1);
    for (; cursor < from; cursor++) {
      if (ops[cursor].kind !== "+") oldLine++;
      if (ops[cursor].kind !== "-") newLine++;
    }
    let oldCount = 0;
    let newCount = 0;
    let body = "";
    for (; cursor < to; cursor++) {
      const op = ops[cursor];
      if (op.kind !== "+") oldCount++;
      if (op.kind !== "-") newCount++;
      body += op.line.endsWith("\n")
        ? `${op.kind}${op.line}`
        : `${op.kind}${op.line}\n\\ No newline at end of file\n`;
    }
    out += `@@ -${rangeStart(oldLine, oldCount)},${oldCount} +${rangeStart(newLine, newCount)},${newCount} @@\n${body}`;
    oldLine += oldCount;
    newLine += newCount;
  }
  return out;
}

/** An empty range names the line before it, as `diff -u` does. */
function rangeStart(linesBefore: number, count: number): number {
  return count === 0 ? linesBefore : linesBefore + 1;
}
