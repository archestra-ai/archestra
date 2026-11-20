type PolicyChange = {
  stage?: "preview";
  delivery: "revision" | "pull_request";
  before: string;
  after: string;
  diff?: string;
  path?: string;
  revision?: number;
  number?: number;
  url?: string;
  errors?: string[];
  enforcement?: { enabled: boolean; reason?: string };
  /** One MCP server's own rules file: the server the change is for. */
  mcpServer?: { id: string; name: string };
  /** The diff of appa.toml when the change also adds the servers' folder to its include list. */
  rootChange?: string;
  /** A pull request that merges by itself once its checks pass. */
  autoMerge?: boolean;
  effective?: { error: string | null; batteries: { status: string }[] };
};

/**
 * A policy file's change, from whatever the call left behind. A chat keeps a
 * result's full texts only when its transport does; the model's copy of the
 * result has the diff alone. So the texts are taken where they are: `after`
 * from the result or from the file the call sent (`input`), `before` from the
 * result or by undoing the diff. Every policy or rules change therefore shows
 * as a diff, however its result was stored.
 */
export function parsePolicyChange(
  output: unknown,
  validationChange = false,
  input?: unknown,
): PolicyChange | null {
  const value = parsePolicyOutput(output);
  if (!value) return null;
  if (
    validationChange &&
    (value.stage === "preview" || value.before === value.after)
  )
    return null;
  const delivery = deliveryOf(value);
  if (!delivery) return null;
  const after = typeof value.after === "string" ? value.after : sentFile(input);
  if (after === null) return null;
  const before =
    typeof value.before === "string"
      ? value.before
      : typeof value.diff === "string"
        ? textBeforeDiff(after, value.diff)
        : null;
  if (before === null) return null;
  return { ...value, delivery, before, after } as PolicyChange;
}

/**
 * What a call that saved or proposed a change reports, without the file's
 * texts: the pull request or the revision. Null for anything else.
 */
export function parsePolicyDelivery(
  output: unknown,
): Omit<PolicyChange, "before" | "after"> | null {
  const value = parsePolicyOutput(output);
  if (!value) return null;
  const delivery = deliveryOf(value);
  return delivery
    ? ({ ...value, delivery } as Omit<PolicyChange, "before" | "after">)
    : null;
}

/**
 * The text a unified diff started from, given the text it led to: its
 * context and added lines are found in `after`, its removed lines put back.
 * Whether that text ended in a newline is read from the diff's
 * "\ No newline at end of file" markers where the diff reaches its last
 * line, and is as `after` ends where it does not. Null when the diff does
 * not fit the text.
 */
export function textBeforeDiff(after: string, diff: string): string | null {
  const lines = after === "" ? [] : after.replace(/\n$/, "").split("\n");
  const before: string[] = [];
  // Whether the last line put into `before` came with a no-newline marker;
  // null when that line was copied from `after` outside any hunk.
  let lastUnterminated: boolean | null = null;
  // The next line of `after`, from 0, the diff has not accounted for.
  let next = 0;
  let inHunk = false;
  // The kind of the hunk line just read: "+", "-" or " ".
  let previous = "";
  for (const raw of diff.replace(/\n$/, "").split("\n")) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(raw);
    if (hunk) {
      // A hunk with no line on the new side names the line before it.
      const start =
        hunk[2] === "0" ? Number(hunk[1]) : Math.max(Number(hunk[1]) - 1, 0);
      if (start < next || start > lines.length) return null;
      if (start > next) lastUnterminated = null;
      before.push(...lines.slice(next, start));
      next = start;
      inHunk = true;
      previous = "";
      continue;
    }
    if (!inHunk) continue;
    if (raw.startsWith("\\")) {
      // The marker speaks for the line above it: a removed or a kept line
      // is the old text's last one.
      if (previous === "-" || previous === " ") lastUnterminated = true;
      continue;
    }
    if (raw.startsWith("+")) {
      if (lines[next] !== raw.slice(1)) return null;
      next++;
      previous = "+";
    } else if (raw.startsWith("-")) {
      before.push(raw.slice(1));
      lastUnterminated = false;
      previous = "-";
    } else {
      if (lines[next] !== raw.slice(1)) return null;
      before.push(lines[next]);
      lastUnterminated = false;
      next++;
      previous = " ";
    }
  }
  if (next < lines.length) lastUnterminated = null;
  before.push(...lines.slice(next));
  if (before.length === 0) return "";
  const unterminated = lastUnterminated ?? !after.endsWith("\n");
  return `${before.join("\n")}${unterminated ? "" : "\n"}`;
}

/** A server's rules always travel as a pull request, named or not. */
function deliveryOf(
  value: Record<string, unknown>,
): PolicyChange["delivery"] | null {
  if (value.delivery === "revision" || value.delivery === "pull_request")
    return value.delivery;
  return value.mcpServer && typeof value.mcpServer === "object"
    ? "pull_request"
    : null;
}

/** The complete file a call sent, directly or through run_tool. */
function sentFile(input: unknown): string | null {
  if (!input || typeof input !== "object") return null;
  const args = input as { content?: unknown; tool_args?: unknown };
  if (typeof args.content === "string") return args.content;
  const wrapped = runToolArguments(args.tool_args);
  return wrapped ? sentFile(wrapped) : null;
}

/**
 * The target's arguments as `run_tool` reads its `tool_args`: an object, or
 * the JSON text of one, which some models send. Null for anything else.
 */
export function runToolArguments(
  value: unknown,
): Record<string, unknown> | null {
  if (value && typeof value === "object" && !Array.isArray(value))
    return value as Record<string, unknown>;
  if (typeof value !== "string") return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export function parsePolicyOutput(
  output: unknown,
): Record<string, unknown> | null {
  let candidate = getPolicyOutputPayload(output);
  if (typeof candidate === "string") {
    try {
      candidate = JSON.parse(candidate);
    } catch {
      return null;
    }
  }
  if (!candidate || typeof candidate !== "object") return null;
  return candidate as Record<string, unknown>;
}

/** Unwrap without decoding JSON, so streamed copies can reuse parsed results. */
export function getPolicyOutputPayload(output: unknown): unknown {
  let candidate = output;
  if (candidate && typeof candidate === "object") {
    if ("isError" in candidate && candidate.isError === true) return null;
    if ("structuredContent" in candidate) {
      candidate = candidate.structuredContent;
    } else if ("content" in candidate) {
      candidate = candidate.content;
    }
  }
  if (Array.isArray(candidate)) {
    candidate = candidate.find(
      (item) => item && typeof item === "object" && item.type === "text",
    )?.text;
  }
  return candidate;
}

/**
 * The tools whose result is a change to a policy file: the organization's
 * policy, or one MCP server's own rules file. A preview shows its diff; the
 * call that saves or proposes it shows one result line.
 */
export function isPolicyChangeTool(shortName: string | null): boolean {
  return shortName !== null && POLICY_CHANGE_TOOLS.has(shortName);
}

/** The calls that save or propose a policy file's change. */
export function isPolicySaveTool(shortName: string | null): boolean {
  return (
    shortName === "update_guardrails_policy" ||
    shortName === "propose_guardrails_server_rules_change"
  );
}

/** The calls that preview a policy file's change. */
export function isPolicyPreviewTool(shortName: string | null): boolean {
  return (
    shortName === "preview_guardrails_policy_change" ||
    shortName === "preview_guardrails_server_rules_change"
  );
}

const POLICY_CHANGE_TOOLS = new Set([
  "preview_guardrails_policy_change",
  "update_guardrails_policy",
  "preview_guardrails_server_rules_change",
  "propose_guardrails_server_rules_change",
]);
