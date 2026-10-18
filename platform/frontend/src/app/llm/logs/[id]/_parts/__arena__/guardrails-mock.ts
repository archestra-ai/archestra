// design-arena: do not commit
// Mock OpenAPPA (guardrails) data for the arena, derived deterministically from
// the session's real tool calls. The real backend does not serve per-session
// consults or a label timeline yet; this models what it would.

import type { ExternalConsult } from "@/lib/openappa/external-consults.query";
import { readMcpToolCall } from "@/lib/mcp-logs/tool-call-content";
import type { Timeline, ToolCallSpan } from "../session-timeline";

/** Least trusted first, as in the default policy trust chain. */
export type Trust = "suspicious" | "trusted";
/** Widest first: public ⊇ internal ⊇ self (plus @group levels). */
export type Audience = "public" | "internal" | "@payments" | "self";

export type ConsultRole =
  | "authority"
  | "annotator"
  | "sanitizer"
  | "audience_source";
export type ConsultOutcome = "answered" | "timeout" | "non_success";
/** What the policy did with the consult's answer (not stored today). */
export type ConsultDecision =
  | "allowed"
  | "blocked"
  | "approved"
  | "labeled"
  | "redacted";

export type MockConsult = {
  id: string;
  /** Unique key, same namespace style as span keys. */
  key: string;
  role: ConsultRole;
  /** The external's configured name. */
  externalName: string;
  backend: "llm" | "hitl" | "archestra" | "url" | "jev";
  outcome: ConsultOutcome;
  decision: ConsultDecision;
  /** One-line answer summary, e.g. "trust → suspicious". */
  answer: string;
  /** Epoch ms. */
  start: number;
  end: number;
  durationMs: number;
  /** Axis position, 0..1, like a span. */
  x: number;
  w: number;
  /** The tool call this consult was raised for, if any. */
  toolCallKey: string | null;
  toolName: string | null;
  /** True when it ran before the call (gate), false when on its result. */
  beforeCall: boolean;
  /** The full stored record, as GET /api/openappa/external-consults serves it. */
  record: ExternalConsult;
};

export type LabelState = { trust: Trust; audience: Audience };

export type LabelSegment = LabelState & {
  /** Epoch ms; the first segment starts at the session origin. */
  start: number;
  end: number;
  x: number;
  w: number;
  /** What changed the label at `start` (absent on the first segment). */
  cause: {
    kind: "admitted" | "narrowed" | "reset" | "released";
    /** Tool whose result or call moved the label. */
    toolName: string | null;
    toolCallKey: string | null;
    consultKey: string | null;
    summary: string;
    /** Why, in words: which rule applied and what it decided. */
    explanation: string;
    /** The policy excerpt (TOML) that produced the change. */
    rule: string;
    /** Where the rule lives, e.g. "Organization policy, revision 14". */
    ruleSource: string;
  } | null;
};

export type GuardrailsData = {
  consults: MockConsult[];
  /** Contiguous, oldest first, covering the whole session. */
  labels: LabelSegment[];
  /** Maps an epoch-ms time onto the timeline's 0..1 axis (idle folds respected). */
  timeToX: (ms: number) => number;
  /** The label in force at a time. */
  labelAt: (ms: number) => LabelState;
  /** Ordered trust levels and audience levels, least→most trusted / widest→narrowest. */
  trustLevels: Trust[];
  audienceLevels: Audience[];
};

export const TRUST_TONE: Record<
  Trust,
  { label: string; bar: string; text: string; soft: string }
> = {
  trusted: {
    label: "Trusted",
    bar: "bg-emerald-500 dark:bg-emerald-400",
    text: "text-emerald-700 dark:text-emerald-300",
    soft: "bg-emerald-500/10",
  },
  suspicious: {
    label: "Suspicious",
    bar: "bg-rose-500 dark:bg-rose-400",
    text: "text-rose-700 dark:text-rose-300",
    soft: "bg-rose-500/10",
  },
};

export const AUDIENCE_TONE: Record<
  Audience,
  { label: string; short: string; bar: string; text: string }
> = {
  public: {
    label: "Public",
    short: "pub",
    bar: "bg-sky-500/70 dark:bg-sky-400/70",
    text: "text-sky-700 dark:text-sky-300",
  },
  internal: {
    label: "Internal",
    short: "int",
    bar: "bg-indigo-500/70 dark:bg-indigo-400/70",
    text: "text-indigo-700 dark:text-indigo-300",
  },
  "@payments": {
    label: "@payments",
    short: "@pay",
    bar: "bg-violet-500/70 dark:bg-violet-400/70",
    text: "text-violet-700 dark:text-violet-300",
  },
  self: {
    label: "Self",
    short: "self",
    bar: "bg-fuchsia-500/70 dark:bg-fuchsia-400/70",
    text: "text-fuchsia-700 dark:text-fuchsia-300",
  },
};

/** Guardrail rows' own colour, distinct from the four span kinds. */
export const CONSULT_KIND = {
  label: "Guardrail",
  short: "Guard",
  bar: "bg-rose-400 dark:bg-rose-400/90",
  ring: "ring-rose-400/50 dark:ring-rose-400/40",
  chip: "bg-rose-500/10 text-rose-700 dark:text-rose-300",
};

export const DECISION_TONE: Record<
  ConsultDecision,
  { label: string; text: string; chip: string }
> = {
  allowed: {
    label: "Allowed",
    text: "text-emerald-700 dark:text-emerald-300",
    chip: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  },
  approved: {
    label: "Approved",
    text: "text-emerald-700 dark:text-emerald-300",
    chip: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  },
  blocked: {
    label: "Blocked",
    text: "text-rose-700 dark:text-rose-300",
    chip: "bg-rose-500/10 text-rose-700 dark:text-rose-300",
  },
  labeled: {
    label: "Labeled",
    text: "text-indigo-700 dark:text-indigo-300",
    chip: "bg-indigo-500/10 text-indigo-700 dark:text-indigo-300",
  },
  redacted: {
    label: "Redacted",
    text: "text-amber-700 dark:text-amber-300",
    chip: "bg-amber-500/10 text-amber-700 dark:text-amber-300",
  },
};

export const ROLE_LABEL: Record<ConsultRole, string> = {
  authority: "Authority",
  annotator: "Annotator",
  sanitizer: "Sanitizer",
  audience_source: "Audience source",
};

export function buildGuardrailsMock(
  timeline: Timeline | null,
): GuardrailsData | null {
  if (!timeline || timeline.spans.length === 0) return null;
  const timeToX = makeTimeToX(timeline);
  const tools = timeline.spans.filter(
    (span): span is ToolCallSpan => span.type === "tool",
  );

  const consults: MockConsult[] = [];
  const push = (
    c: Omit<MockConsult, "x" | "w" | "key" | "end" | "record">,
    args: unknown = {},
  ) => {
    const end = c.start + c.durationMs;
    const x = timeToX(c.start);
    consults.push({
      ...c,
      key: `consult:${c.id}`,
      end,
      x,
      w: Math.max(0, timeToX(end) - x),
      record: mockRecord(c, end, args),
    });
  };

  for (const tool of tools) {
    const content = readMcpToolCall(tool.call);
    const name = content.toolName ?? "tool";
    const args = content.args ?? {};
    const h = hash(tool.call.id);
    const writes = WRITE_TOOLS.some((w) => name.includes(w));
    const reads = READ_TOOLS.some((r) => name.includes(r));
    // Authority gate before writes and a share of everything else.
    if (writes || h % 5 === 0) {
      const human =
        name.includes("create_pull_request") || name.includes("post_message");
      const blocked = !human && h % 23 === 0;
      const dur = human ? 4200 + (h % 9000) : 140 + (h % 900);
      push(
        {
          id: `${tool.call.id}-auth`,
          role: "authority",
          externalName: human ? "approval" : "write-policy",
          backend: human ? "hitl" : "llm",
          outcome: h % 41 === 0 ? "timeout" : "answered",
          decision: blocked ? "blocked" : human ? "approved" : "allowed",
          answer: blocked
            ? `deny: ${name} writes outside the task scope`
            : human
              ? "approved by Admin"
              : "allow",
          start: tool.start - dur - 30,
          durationMs: dur,
          toolCallKey: tool.key,
          toolName: name,
          beforeCall: true,
        },
        args,
      );
    }
    // Annotators label what reads bring back.
    if (reads && h % 2 === 0) {
      const dur = 220 + (h % 700);
      const external =
        name.includes("get_file_contents") ||
        name.includes("search_code") ||
        name.includes("get_job_logs");
      push(
        {
          id: `${tool.call.id}-ann`,
          role: "annotator",
          externalName: "trust-annotator",
          backend: "llm",
          outcome: h % 37 === 0 ? "non_success" : "answered",
          decision: "labeled",
          answer: external
            ? "trust → suspicious (third-party content)"
            : "audience → internal",
          start: tool.end + 15,
          durationMs: dur,
          toolCallKey: tool.key,
          toolName: name,
          beforeCall: false,
        },
        args,
      );
    }
    // A sanitizer on postgres results.
    if (name.includes("query") && h % 3 === 0) {
      const dur = 60 + (h % 200);
      push(
        {
          id: `${tool.call.id}-san`,
          role: "sanitizer",
          externalName: "pii-redactor",
          backend: "archestra",
          outcome: "answered",
          decision: "redacted",
          answer: "redacted 3 email addresses",
          start: tool.end + 10,
          durationMs: dur,
          toolCallKey: tool.key,
          toolName: name,
          beforeCall: false,
        },
        args,
      );
    }
  }
  consults.sort((a, b) => a.start - b.start);

  // Label timeline: a handful of moves driven by specific tool results.
  const origin = timeline.origin;
  const finish = Math.max(...timeline.spans.map((s) => s.end));
  const moves: {
    at: number;
    state: LabelState;
    cause: LabelSegment["cause"];
  }[] = [];
  const firstOf = (match: (name: string) => boolean, after = origin) =>
    tools.find(
      (t) => t.start > after && match(readMcpToolCall(t.call).toolName ?? ""),
    );
  const internalRead = firstOf(
    (n) => n.includes("query") || n.includes("search"),
  );
  if (internalRead) {
    moves.push({
      at: internalRead.end + 20,
      state: { trust: "trusted", audience: "internal" },
      cause: {
        kind: "narrowed",
        toolName: readMcpToolCall(internalRead.call).toolName,
        toolCallKey: internalRead.key,
        consultKey:
          consults.find(
            (c) => c.toolCallKey === internalRead.key && c.role === "annotator",
          )?.key ?? null,
        summary: "Read internal data; audience narrowed to internal",
        explanation:
          "The rule for this tool marks what it returns as internal, so everything the agent does after it may only reach people inside the organization.",
        rule: `[policy.audience]
internal = ["archestra:members"]

[[policy.tool]]
name = "mcp/${internalRead.call.mcpServerName}/${readMcpToolCall(internalRead.call).toolName}"
delta = { audience = ["internal"] }`,
        ruleSource: "Organization policy · revision 14",
      },
    });
  }
  const external = firstOf(
    (n) => n.includes("get_file_contents") || n.includes("get_job_logs"),
    internalRead?.end ?? origin,
  );
  if (external) {
    moves.push({
      at: external.end + 20,
      state: { trust: "suspicious", audience: "internal" },
      cause: {
        kind: "admitted",
        toolName: readMcpToolCall(external.call).toolName,
        toolCallKey: external.key,
        consultKey:
          consults.find(
            (c) => c.toolCallKey === external.key && c.role === "annotator",
          )?.key ?? null,
        summary: "Admitted third-party content; trust lowered to suspicious",
        explanation:
          "No rule names this tool, so the catch-all annotator asked the default model to judge its result. It found third-party content and answered trust: suspicious (86%).",
        rule: `[[policy.tool]]
name = "*"
annotator = "archestra.undeclared-tool"

[[policy.annotator]]
name = "archestra.undeclared-tool"
builtin = "archestra"
ranks = ["suspicious", "trusted"]`,
        ruleSource: "Organization policy · revision 14",
      },
    });
  }
  const team = firstOf(
    (n) => n.includes("post_message"),
    external?.end ?? origin,
  );
  if (team) {
    moves.push({
      at: team.start - 5,
      state: { trust: "suspicious", audience: "@payments" },
      cause: {
        kind: "released",
        toolName: readMcpToolCall(team.call).toolName,
        toolCallKey: team.key,
        consultKey: null,
        summary: "Released to #payments; audience is now @payments",
        explanation:
          "Posting to a channel releases the session's context to that channel's members, so the audience narrows to the team that can read it.",
        rule: `[[policy.tool]]
name = "mcp/slack/post_message"
annotator = "archestra.audience"

[policy.audience]
"@payments" = ["archestra:team/payments"]`,
        ruleSource: "Slack battery · v1.4",
      },
    });
  }
  // A reset late in the session (e.g. break-the-glass yell).
  const late = tools[Math.floor(tools.length * 0.85)];
  if (late && late.start > (team?.start ?? external?.end ?? origin)) {
    moves.push({
      at: late.start - 5,
      state: { trust: "trusted", audience: "public" },
      cause: {
        kind: "reset",
        toolName: "yell",
        toolCallKey: null,
        consultKey: null,
        summary: "Guardrails turned off for this session; label reset",
        explanation:
          "Break the glass is on for this organization: a yell from the agent turned guardrails off for the rest of the session, which clears the label.",
        rule: `[policy.deployment]
break_the_glass = true`,
        ruleSource: "Organization policy · revision 14",
      },
    });
  }
  moves.sort((a, b) => a.at - b.at);

  const labels: LabelSegment[] = [];
  let state: LabelState = { trust: "trusted", audience: "public" };
  let start = origin;
  let cause: LabelSegment["cause"] = null;
  for (const move of moves) {
    labels.push(segment(start, move.at, state, cause, timeToX));
    state = move.state;
    start = move.at;
    cause = move.cause;
  }
  labels.push(segment(start, finish, state, cause, timeToX));

  return {
    consults,
    labels,
    timeToX,
    labelAt: (ms) => {
      const hit =
        labels.find((s) => ms >= s.start && ms < s.end) ??
        labels[labels.length - 1];
      return { trust: hit.trust, audience: hit.audience };
    },
    trustLevels: ["suspicious", "trusted"],
    audienceLevels: ["public", "internal", "@payments", "self"],
  };
}

// ============================================================================
// Internal helpers
// ============================================================================

const WRITE_TOOLS = [
  "edit_file",
  "create",
  "post_message",
  "run_command",
  "delete",
  "push",
];
const READ_TOOLS = ["get_", "list_", "search", "query", "read_file"];

function segment(
  start: number,
  end: number,
  state: LabelState,
  cause: LabelSegment["cause"],
  timeToX: (ms: number) => number,
): LabelSegment {
  const x = timeToX(start);
  return { ...state, start, end, cause, x, w: Math.max(0, timeToX(end) - x) };
}

/**
 * Piecewise-linear time → x from every span edge the timeline already placed,
 * so mock records land where real ones would, idle folds included.
 */
function makeTimeToX(timeline: Timeline): (ms: number) => number {
  const points = timeline.spans
    .flatMap((s) => [
      { t: s.start, x: s.x },
      { t: s.end, x: s.x + s.w },
    ])
    .sort((a, b) => a.t - b.t || a.x - b.x);
  return (ms) => {
    if (points.length === 0) return 0;
    if (ms <= points[0].t) return points[0].x;
    const last = points[points.length - 1];
    if (ms >= last.t) return last.x;
    let lo = 0;
    let hi = points.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (points[mid].t <= ms) lo = mid;
      else hi = mid;
    }
    const a = points[lo];
    const b = points[hi];
    if (b.t === a.t) return a.x;
    return a.x + ((ms - a.t) / (b.t - a.t)) * (b.x - a.x);
  };
}

function hash(value: string): number {
  let h = 2166136261;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}

function mockRecord(
  c: Omit<MockConsult, "x" | "w" | "key" | "end" | "record">,
  end: number,
  args: unknown,
): ExternalConsult {
  const tool = c.toolName ?? "tool";
  const request =
    c.role === "authority"
      ? {
          version: 1,
          kind: "authorize",
          tool: { name: tool, arguments: args },
          label: { trust: "trusted", audience: ["internal"] },
          question: `May the agent call ${tool} with these arguments?`,
        }
      : c.role === "sanitizer"
        ? {
            version: 1,
            kind: "sanitize",
            tool: { name: tool, arguments: args },
          }
        : {
            version: 1,
            kind: "annotate",
            tool: { name: tool, arguments: args },
            result_excerpt: "…first 2 KB of the tool's result…",
          };
  const answer =
    c.outcome !== "answered"
      ? null
      : c.decision === "blocked"
        ? { allow: false, reason: c.answer.replace(/^deny: /, "") }
        : c.decision === "approved"
          ? { allow: true, approved_by: "Admin", channel: "chat" }
          : c.decision === "allowed"
            ? { allow: true }
            : c.decision === "redacted"
              ? { redactions: [{ kind: "email", count: 3 }] }
              : {
                  delta_trust: c.answer.includes("suspicious")
                    ? "suspicious"
                    : "trusted",
                  delta_audience: c.answer.includes("internal")
                    ? "internal"
                    : "public",
                };
  const diagnostics =
    c.backend === "llm" && c.outcome === "answered"
      ? btoa(
          JSON.stringify({
            jev_diagnostics: {
              version: 1,
              model: "claude-haiku-4-5",
              attempts: ["ok"],
              labels:
                c.role === "annotator"
                  ? {
                      delta_trust: {
                        probabilities: c.answer.includes("suspicious")
                          ? { suspicious: 0.86, trusted: 0.14 }
                          : { trusted: 0.93, suspicious: 0.07 },
                        decision: c.answer.includes("suspicious")
                          ? "suspicious"
                          : "trusted",
                      },
                      delta_audience: {
                        probabilities: { internal: 0.71, public: 0.29 },
                        decision: "internal",
                      },
                    }
                  : {
                      requires_trusted: {
                        probability: c.decision === "blocked" ? 0.18 : 0.94,
                        threshold: 0.5,
                        decision: c.decision !== "blocked",
                      },
                    },
              elapsed_ms: c.durationMs,
            },
          }),
        )
      : null;
  return {
    id: `00000000-0000-4000-8000-${String(hash(c.id)).padStart(12, "0").slice(0, 12)}`,
    organizationId: "org",
    sessionId: "user:admin|5e9a3b2c-7d4f-4b8e-a1c3-2f6b9d4e7a01",
    callerId: "user:admin",
    createdAt: new Date(end).toISOString(),
    startedAt: new Date(c.start).toISOString(),
    durationMs: c.durationMs,
    role: c.role,
    externalName: c.externalName,
    backend: c.backend,
    request,
    outcome: c.outcome,
    answer,
    rawResponse: null,
    httpStatus: c.backend === "llm" || c.backend === "url" ? 200 : null,
    diagnostics,
    diagnosticsTruncated: false,
    root: "root:5e9a3b2c",
    trajectory: "root:5e9a3b2c",
    callId: c.toolCallKey ? `toolu_${c.id.slice(0, 18)}` : null,
    offerId: null,
    callDigest: null,
  };
}
