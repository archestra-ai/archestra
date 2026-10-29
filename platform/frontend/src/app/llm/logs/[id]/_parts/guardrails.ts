// The session trace's guardrails: the checks OpenAPPA ran (stored external
// consults), the session's label over time (recorded label changes) and the
// agent's yells, placed on the trace's own time axis.

import { policyLineHref } from "@/app/openappa/_parts/policy-line-href";
import { readMcpToolCall } from "@/lib/mcp-logs/tool-call-content";
import type { ExternalConsult } from "@/lib/openappa/external-consults.query";
import type { LabelChangeRecord } from "@/lib/openappa/label-changes.query";
import type { OpenAppaYell } from "@/lib/openappa-yells.query";
import {
  type Timeline,
  type ToolCallSpan,
  toolCallSpanKey,
} from "./session-timeline";

/** A trust level, such as `trusted` or `suspicious` (policies may add more). */
export type Trust = string;
/** An audience, such as `public`, `internal` or a group (policies may add more). */
export type Audience = string;

export type ConsultRole =
  | "authority"
  | "annotator"
  | "sanitizer"
  | "audience_source";
export type ConsultOutcome = "answered" | "timeout" | "non_success";
/** What the policy made of the consult's answer, read from the answer. */
export type ConsultDecision =
  | "allowed"
  | "blocked"
  | "approved"
  | "labeled"
  | "redacted";

/** One stored consult, in the trace's shape. */
export type TraceConsult = {
  id: string;
  /** Unique key, in the same namespace style as span keys. */
  key: string;
  role: ConsultRole;
  /** The external's configured name. */
  externalName: string;
  backend: ExternalConsult["backend"];
  outcome: ConsultOutcome;
  decision: ConsultDecision;
  /** Epoch ms. */
  start: number;
  end: number;
  durationMs: number;
  /** Axis position, 0..1, like a span. */
  x: number;
  w: number;
  /** The tool call this consult was raised for, if it is in the trace. */
  toolCallKey: string | null;
  toolName: string | null;
  /** True when it ran before the call (gate), false when on its result. */
  beforeCall: boolean;
  /** The full stored record. */
  record: ExternalConsult;
};

export type LabelState = { trust: Trust; audience: Audience };

export type LabelSegment = LabelState & {
  /** Epoch ms; the first segment starts at the session's first span. */
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
    /** Why, in words. */
    explanation: string;
    /** The policy rule that most likely applied (TOML), when known. */
    rule: string | null;
    /** Where that rule lives, e.g. "Organization policy, line 12". */
    ruleSource: string | null;
    /** Opens that line in the policy editor. */
    ruleHref: string | null;
  } | null;
};

/** A yell the agent sent from this session, in the trace's shape. */
export type TraceYell = {
  /** `yell:<id>`. */
  key: string;
  id: string;
  message: string;
  /** Sent while break the glass was on: guardrails were off from here. */
  superyell: boolean;
  withTrajectory: boolean;
  hasArchive: boolean;
  /** Epoch ms. */
  at: number;
  /** Position on the trace's axis, 0..1. */
  x: number;
  /** The logged `yell` call's span, when it is in this trace. */
  toolCallKey: string | null;
  resolvedAt: string | null;
  /** The chat an admin opened to investigate it, if any. */
  conversationId: string | null;
};

export type GuardrailsData = {
  consults: TraceConsult[];
  /** Oldest first. */
  yells: TraceYell[];
  /** When the first superyell turned guardrails off, epoch ms; else null. */
  guardrailsOffAt: number | null;
  /** Contiguous, oldest first; empty when no label change was recorded. */
  labels: LabelSegment[];
  /** Maps an epoch-ms time onto the timeline's 0..1 axis (idle folds respected). */
  timeToX: (ms: number) => number;
  /** The label in force at a time, or null without a recorded history. */
  labelAt: (ms: number) => LabelState | null;
};

/**
 * The trace's guardrails from what was stored: consults tied to the tool
 * calls they were raised for, and label segments between recorded changes.
 */
export function buildGuardrails({
  timeline,
  consults,
  labelChanges,
  yells = [],
}: {
  timeline: Timeline | null;
  consults: ExternalConsult[];
  labelChanges: LabelChangeRecord[];
  yells?: OpenAppaYell[];
}): GuardrailsData | null {
  if (!timeline || timeline.spans.length === 0) return null;
  if (consults.length === 0 && labelChanges.length === 0 && yells.length === 0)
    return null;
  const timeToX = makeTimeToX(timeline);
  const toolByCallId = new Map<string, ToolCallSpan>();
  for (const span of timeline.spans) {
    if (span.type === "tool" && span.call.llmToolCallId) {
      toolByCallId.set(modelCallId(span.call.llmToolCallId), span);
    }
  }
  const traceConsults = consults.map((consult) =>
    fromRecord({ consult, toolByCallId, timeToX }),
  );
  const labels = toSegments({
    changes: labelChanges,
    timeline,
    toolByCallId,
    consults: traceConsults,
    timeToX,
  });
  const spanKeys = new Set(timeline.spans.map((span) => span.key));
  const traceYells = yells
    .map((yell): TraceYell => {
      const at = Date.parse(String(yell.createdAt));
      const callKey = yell.trace?.mcpToolCallId
        ? toolCallSpanKey(yell.trace.mcpToolCallId)
        : null;
      return {
        key: `yell:${yell.id}`,
        id: yell.id,
        message: yell.message,
        superyell: yell.superyell,
        withTrajectory: yell.withTrajectory,
        hasArchive: yell.hasArchive,
        at,
        x: timeToX(at),
        toolCallKey: callKey && spanKeys.has(callKey) ? callKey : null,
        resolvedAt: yell.resolvedAt ? String(yell.resolvedAt) : null,
        conversationId: yell.conversation?.id ?? null,
      };
    })
    .sort((a, b) => a.at - b.at);
  return {
    consults: traceConsults,
    yells: traceYells,
    guardrailsOffAt: traceYells.find((yell) => yell.superyell)?.at ?? null,
    labels,
    timeToX,
    labelAt: (ms) => {
      if (labels.length === 0) return null;
      const hit =
        [...labels].reverse().find((segment) => segment.start <= ms) ??
        labels[0];
      return { trust: hit.trust, audience: hit.audience };
    },
  };
}

/** A trust level's colours and words; unknown levels read as neutral. */
export function trustTone(trust: Trust) {
  return (
    TRUST_TONES[trust] ?? {
      label: titleCase(trust),
      bar: "bg-muted-foreground/60",
      text: "text-foreground",
      soft: "bg-muted",
    }
  );
}

/** An audience's colours and words; groups and custom levels read as violet. */
export function audienceTone(audience: Audience) {
  return (
    AUDIENCE_TONES[audience] ?? {
      label: audience.startsWith("@") ? audience : titleCase(audience),
      short: audience.slice(0, 4),
      bar: "bg-violet-500/70 dark:bg-violet-400/70",
      text: "text-violet-700 dark:text-violet-300",
    }
  );
}

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

// ============================================================================
// Internal helpers
// ============================================================================

const TRUST_TONES: Record<
  string,
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

const AUDIENCE_TONES: Record<
  string,
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
  self: {
    label: "Self",
    short: "self",
    bar: "bg-fuchsia-500/70 dark:bg-fuchsia-400/70",
    text: "text-fuchsia-700 dark:text-fuchsia-300",
  },
};

const CHANGE_KIND: Record<
  LabelChangeRecord["event"],
  NonNullable<LabelSegment["cause"]>["kind"]
> = {
  session_start: "reset",
  tool_result: "admitted",
  tool_call: "narrowed",
  remedy: "narrowed",
  child_return: "admitted",
  other: "narrowed",
};

function toSegments({
  changes,
  timeline,
  toolByCallId,
  consults,
  timeToX,
}: {
  changes: LabelChangeRecord[];
  timeline: Timeline;
  toolByCallId: Map<string, ToolCallSpan>;
  consults: TraceConsult[];
  timeToX: (ms: number) => number;
}): LabelSegment[] {
  if (changes.length === 0) return [];
  const first = Math.min(...timeline.spans.map((span) => span.start));
  const last = Math.max(...timeline.spans.map((span) => span.end));
  const segments: LabelSegment[] = [];
  const place = (
    state: LabelState,
    start: number,
    cause: LabelSegment["cause"],
  ) => {
    const x = timeToX(start);
    segments.push({ ...state, start, end: last, x, w: 0, cause });
  };
  // The first row is the root's baseline (or, for a session recorded only
  // from part-way, the label before its first change).
  place(
    { trust: changes[0].trustBefore, audience: changes[0].audienceBefore },
    first,
    null,
  );
  for (const change of changes) {
    if (
      change.trustBefore === change.trustAfter &&
      change.audienceBefore === change.audienceAfter
    )
      continue;
    const tool = change.callId
      ? toolByCallId.get(change.callId.replace(/^call:/, ""))
      : undefined;
    const toolName =
      (tool ? readMcpToolCall(tool.call).toolName : null) ??
      change.tool ??
      null;
    // The check that labeled the result, when one ran on this call.
    const consult = consults.find(
      (c) =>
        c.record.callId === change.callId &&
        change.callId !== null &&
        c.role === "annotator",
    );
    place(
      { trust: change.trustAfter, audience: change.audienceAfter },
      Math.max(first, new Date(change.createdAt).getTime()),
      {
        kind: CHANGE_KIND[change.event],
        toolName,
        toolCallKey: tool?.key ?? null,
        consultKey: consult?.key ?? null,
        summary: changeSummary({ change, toolName }),
        explanation: changeExplanation({ change, toolName }),
        rule: change.rule?.text ?? null,
        ruleSource: change.rule ? ruleSource(change.rule) : null,
        ruleHref: change.rule
          ? policyLineHref({
              entry: change.rule.batteryEntry,
              line: change.rule.line,
            })
          : null,
      },
    );
  }
  for (let i = 0; i < segments.length; i++) {
    const next = segments[i + 1];
    segments[i].end = next ? next.start : last;
    segments[i].w = Math.max(0, timeToX(segments[i].end) - segments[i].x);
  }
  return segments;
}

/** Where a rule lives, in words, e.g. "Battery github, line 12". */
function ruleSource(rule: NonNullable<LabelChangeRecord["rule"]>): string {
  const where =
    rule.source === "battery"
      ? `Battery ${rule.battery ?? rule.batteryEntry ?? ""}`.trim()
      : rule.source === "catchall"
        ? "Organization policy, catch-all rule"
        : "Organization policy";
  return rule.line !== null ? `${where}, line ${rule.line}` : where;
}

function changeSummary({
  change,
  toolName,
}: {
  change: LabelChangeRecord;
  toolName: string | null;
}): string {
  const what = toolName ?? "a tool";
  switch (change.event) {
    case "tool_result":
      return `${what} returned`;
    case "tool_call":
      return `${what} was called`;
    case "remedy":
      return "A remedy plan was applied";
    case "session_start":
    case "other":
      return "The session's label changed";
    case "child_return":
      return "A sub-agent returned";
  }
}

function changeExplanation({
  change,
  toolName,
}: {
  change: LabelChangeRecord;
  toolName: string | null;
}): string {
  const trust =
    change.trustBefore !== change.trustAfter
      ? `trust ${trustTone(change.trustAfter).label.toLowerCase()}`
      : null;
  const audience =
    change.audienceBefore !== change.audienceAfter
      ? `audience ${audienceTone(change.audienceAfter).label}`
      : null;
  const now = [trust, audience].filter(Boolean).join(" and ");
  const what = toolName ?? "the tool";
  const lead =
    change.event === "tool_result"
      ? `What ${what} returned set the session's ${now}`
      : change.event === "tool_call"
        ? `Calling ${what} set the session's ${now}`
        : change.event === "remedy"
          ? `An approved remedy plan set the session's ${now}`
          : change.event === "child_return"
            ? `A sub-agent's result set the session's ${now}`
            : `The session's ${now} changed`;
  return `${lead}. Everything the agent does after this point carries that label.`;
}

/** A stored consult in the trace's shape: placed on the axis, tied to its call. */
function fromRecord({
  consult,
  toolByCallId,
  timeToX,
}: {
  consult: ExternalConsult;
  toolByCallId: Map<string, ToolCallSpan>;
  timeToX: (ms: number) => number;
}): TraceConsult {
  const start = new Date(consult.startedAt).getTime();
  const end = start + consult.durationMs;
  // The runtime files a consult under its operation id, `call:<id>`.
  const tool = consult.callId
    ? toolByCallId.get(consult.callId.replace(/^call:/, ""))
    : undefined;
  const role = (ROLES as readonly string[]).includes(consult.role)
    ? (consult.role as ConsultRole)
    : "annotator";
  const answered = consult.outcome === "answered";
  const answer = (consult.answer ?? {}) as Record<string, unknown>;
  const decision: ConsultDecision =
    role === "authority"
      ? !answered || answer.allow === false
        ? "blocked"
        : answer.approved_by
          ? "approved"
          : "allowed"
      : role === "sanitizer"
        ? "redacted"
        : "labeled";
  const x = timeToX(start);
  return {
    id: consult.id,
    key: `consult:${consult.id}`,
    role,
    externalName: consult.externalName,
    backend: consult.backend,
    outcome:
      consult.outcome === "answered" || consult.outcome === "timeout"
        ? consult.outcome
        : "non_success",
    decision,
    start,
    end,
    durationMs: consult.durationMs,
    x,
    w: Math.max(0, timeToX(end) - x),
    toolCallKey: tool?.key ?? null,
    toolName: tool ? (readMcpToolCall(tool.call).toolName ?? null) : null,
    beforeCall: role === "authority",
    record: consult,
  };
}

const ROLES = ["authority", "annotator", "sanitizer", "audience_source"];

/**
 * The provider's id inside a trajectory stamp (`appat1` + base64url of
 * `<session>\0<call id>` + a 22-character tag), or the id as given.
 */
function modelCallId(id: string): string {
  if (!id.startsWith("appat1") || id.length <= 6 + 22) return id;
  try {
    const payload = id.slice(6, -22).replace(/-/g, "+").replace(/_/g, "/");
    const decoded = atob(
      payload.padEnd(Math.ceil(payload.length / 4) * 4, "="),
    );
    const separator = decoded.indexOf("\u0000");
    return separator > 0 ? decoded.slice(separator + 1) : id;
  } catch {
    return id;
  }
}

/**
 * Piecewise-linear time → x from every span edge the timeline already placed,
 * so guardrail records land where the spans around them are, idle folds
 * included.
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

function titleCase(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1).replace(/_/g, " ");
}
