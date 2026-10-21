import type { archestraApiTypes, InteractionSource } from "@archestra/shared";
import {
  sessionTitleOf,
  sourceLabel,
} from "@/app/llm/logs/_parts/logs-table-format";
import { readMcpToolCall } from "@/lib/mcp-logs/tool-call-content";
import { formatElapsed } from "@/lib/utils/format-duration";

// Where each record of a session sits on the page's shared time axis, and
// what kind of record it is. Pure: the waterfall and the details pane render
// from this.

export type InteractionSummary =
  archestraApiTypes.GetInteractionSummariesResponses["200"]["data"][number];

export type SessionToolCall =
  archestraApiTypes.GetMcpToolCallsResponses["200"]["data"][number];

export type RequestKind = "main" | "subagent" | "auxiliary";
export type SpanKind = RequestKind | "tool";

type SpanGeometry = {
  /** Unique across requests and tool calls; what selection is keyed by. */
  key: string;
  /** Epoch ms. */
  start: number;
  end: number;
  /** Position on the axis, 0..1. */
  x: number;
  w: number;
};

export type RequestSpan = SpanGeometry & {
  type: "request";
  row: InteractionSummary;
  kind: RequestKind;
};

export type ToolCallSpan = SpanGeometry & {
  type: "tool";
  call: SessionToolCall;
  kind: "tool";
};

export type TimelineSpan = RequestSpan | ToolCallSpan;

export type Timeline = {
  /** Oldest first. */
  spans: TimelineSpan[];
  /** Epoch ms of the earliest start: what "+12s" offsets count from. */
  origin: number;
  ticks: { x: number; label: string }[];
  /** Idle stretches drawn at a fixed width instead of to scale. */
  breaks: { x: number; w: number; gapMs: number }[];
  /** Wall-clock time from the first start to the last end. */
  realSpanMs: number;
};

/**
 * Lays requests and the MCP tool calls they issued on one axis. `createdAt`
 * is written when a record completes and `durationMs` is its total time, so a
 * span runs from createdAt − duration to createdAt; a tool call runs after
 * the request that asked for it, so ordering by start interleaves each call
 * under its request. Gaps between busy stretches that are long relative to
 * the session fold into fixed-width breaks, so an hour of idling does not
 * squash every record into a sliver at either end.
 */
export function buildTimeline({
  requests,
  toolCalls = [],
}: {
  requests: InteractionSummary[];
  toolCalls?: SessionToolCall[];
}): Timeline | null {
  type Placed = Omit<RequestSpan, "x" | "w"> | Omit<ToolCallSpan, "x" | "w">;
  const timing = (record: { createdAt: string; durationMs: number | null }) => {
    const end = new Date(record.createdAt).getTime();
    return { start: end - Math.max(0, record.durationMs ?? 0), end };
  };
  const raw: Placed[] = [
    ...requests.map(
      (row): Placed => ({
        type: "request",
        key: requestSpanKey(row.id),
        row,
        kind: spanKind(row),
        ...timing(row),
      }),
    ),
    ...visibleToolCalls(toolCalls).map(
      (call): Placed => ({
        type: "tool",
        key: toolCallSpanKey(call.id),
        call,
        kind: "tool",
        ...timing(call),
      }),
    ),
  ].sort((a, b) => a.start - b.start || a.end - b.end);
  if (raw.length === 0) return null;

  const origin = raw[0].start;
  const finish = Math.max(...raw.map((r) => r.end));
  const realSpanMs = Math.max(0, finish - origin);

  // Merge overlapping spans into busy intervals; the gaps between them are
  // the candidates for folding.
  const busy: { start: number; end: number }[] = [];
  for (const r of raw) {
    const last = busy[busy.length - 1];
    if (last && r.start <= last.end) last.end = Math.max(last.end, r.end);
    else busy.push({ start: r.start, end: r.end });
  }
  const gaps: { start: number; end: number }[] = [];
  for (let i = 1; i < busy.length; i++) {
    gaps.push({ start: busy[i - 1].end, end: busy[i].start });
  }
  const foldThreshold = Math.max(FOLD_MIN_GAP_MS, realSpanMs * FOLD_SHARE);
  const folded = gaps.filter((g) => g.end - g.start > foldThreshold);
  const keptMs =
    realSpanMs - folded.reduce((sum, g) => sum + (g.end - g.start), 0);
  const breakMs = Math.max(keptMs * BREAK_SHARE, 1);

  // Piecewise mapping: real [a, b] → visual [va, vb].
  const segments: { a: number; b: number; va: number; vb: number }[] = [];
  let cursor = origin;
  let visual = 0;
  for (const gap of folded) {
    segments.push({
      a: cursor,
      b: gap.start,
      va: visual,
      vb: visual + (gap.start - cursor),
    });
    visual += gap.start - cursor;
    segments.push({
      a: gap.start,
      b: gap.end,
      va: visual,
      vb: visual + breakMs,
    });
    visual += breakMs;
    cursor = gap.end;
  }
  segments.push({
    a: cursor,
    b: finish,
    va: visual,
    vb: visual + (finish - cursor),
  });
  visual += finish - cursor;
  const total = visual > 0 ? visual : 1;

  const toX = (t: number) => {
    for (const s of segments) {
      if (t <= s.b) {
        const f = s.b === s.a ? 0 : (t - s.a) / (s.b - s.a);
        return (s.va + f * (s.vb - s.va)) / total;
      }
    }
    return 1;
  };
  const fromX = (x: number) => {
    const target = x * total;
    for (const s of segments) {
      if (target <= s.vb) {
        const f = s.vb === s.va ? 0 : (target - s.va) / (s.vb - s.va);
        return s.a + f * (s.b - s.a);
      }
    }
    return finish;
  };

  // A lone instant (one untimed request, or several at the same moment) has
  // no axis to place it on; it fills the track.
  const single = realSpanMs === 0;
  const spans = raw.map((r): TimelineSpan => {
    if (single) return { ...r, x: 0, w: 1 };
    const x = toX(r.start);
    return { ...r, x, w: Math.max(0, toX(r.end) - x) };
  });

  const breaks = folded.map((gap) => {
    const x = toX(gap.start);
    return { x, w: toX(gap.end) - x, gapMs: gap.end - gap.start };
  });

  // Five evenly spaced ticks, skipping any that land inside a fold.
  const ticks = single
    ? [{ x: 0, label: "0s" }]
    : [0, 0.25, 0.5, 0.75, 1]
        .filter(
          (x) => !breaks.some((b) => x > b.x + 0.005 && x < b.x + b.w - 0.005),
        )
        .map((x) => ({
          x,
          label: x === 0 ? "0s" : `+${formatElapsed(fromX(x) - origin)}`,
        }));

  return { spans, origin, ticks, breaks, realSpanMs };
}

export function requestSpanKey(interactionId: string): string {
  return `request:${interactionId}`;
}

export function toolCallSpanKey(mcpToolCallId: string): string {
  return `tool:${mcpToolCallId}`;
}

/**
 * The calls worth a row. A dispatch through `run_tool` logs the outer
 * `run_tool` call and the tool it ran under the model's one tool-call id;
 * the inner row is the one that says what happened, so the outer one is
 * dropped when both are present.
 */
export function visibleToolCalls(calls: SessionToolCall[]): SessionToolCall[] {
  const dispatched = new Set(
    calls.flatMap((call) =>
      call.llmToolCallId && !isRunToolDispatch(call)
        ? [call.llmToolCallId]
        : [],
    ),
  );
  return calls.filter(
    (call) =>
      !(
        call.llmToolCallId &&
        dispatched.has(call.llmToolCallId) &&
        isRunToolDispatch(call)
      ),
  );
}

/**
 * Main-thread turns, sub-agents, and side requests (titles, compaction,
 * embeddings, guardrail checks) read differently, so each gets its own
 * colour on the axis.
 */
export function spanKind(
  row: Pick<InteractionSummary, "requestType" | "source">,
): RequestKind {
  if (row.requestType === "subagent" || row.source?.endsWith(":subagent")) {
    return "subagent";
  }
  if (row.source && AUXILIARY_SOURCES.has(row.source)) return "auxiliary";
  return "main";
}

/**
 * A request's name in the list: the sub-agent's label, what a side request
 * did, or for a main-thread request what it produced (the tools it called,
 * else the start of its reply). One prompt drives every request of an agent
 * loop, so naming them by it repeated one line down the whole list; the
 * prompt is the fallback for requests logged before their output was kept,
 * then the agent's name.
 */
export function requestLabel(
  row: Pick<
    InteractionSummary,
    | "requestType"
    | "source"
    | "externalAgentIdLabel"
    | "externalAgentId"
    | "userMessagePreview"
    | "responseToolNames"
    | "responseTextPreview"
  >,
  profileName: string | null | undefined,
): string {
  const kind = spanKind(row);
  if (kind === "subagent") return row.externalAgentIdLabel || "Sub-agent";
  if (kind === "auxiliary" && row.source) return sourceLabel(row.source);
  return (
    requestOutcome(row) ||
    requestPrompt(row) ||
    row.externalAgentIdLabel ||
    row.externalAgentId ||
    profileName ||
    "Main"
  );
}

/** The prompt a request served, when one was captured. */
export function requestPrompt(
  row: Pick<InteractionSummary, "userMessagePreview">,
): string | null {
  return sessionTitleOf({ lastUserMessagePreview: row.userMessagePreview });
}

/**
 * A client's own prefix on an MCP tool (`mcp__<gateway>__`) names where the
 * client reached it, not the tool: `linear__get_issue` says it.
 */
export function shortToolName(name: string): string {
  return name.replace(/^mcp__.+?__/, "");
}

export const SPAN_KINDS: Record<
  SpanKind,
  { label: string; short: string; bar: string; ring: string; chip: string }
> = {
  main: {
    label: "Main",
    short: "Main",
    bar: "bg-sky-500 dark:bg-sky-400",
    ring: "ring-sky-500/40 dark:ring-sky-400/40",
    chip: "bg-sky-500/10 text-sky-700 dark:text-sky-300",
  },
  subagent: {
    label: "Sub-agent",
    short: "Sub-agent",
    bar: "bg-violet-500 dark:bg-violet-400",
    ring: "ring-violet-500/40 dark:ring-violet-400/40",
    chip: "bg-violet-500/10 text-violet-700 dark:text-violet-300",
  },
  auxiliary: {
    label: "Side request",
    short: "Side",
    bar: "bg-amber-400 dark:bg-amber-500/80",
    ring: "ring-amber-400/50 dark:ring-amber-500/40",
    chip: "bg-amber-500/10 text-amber-700 dark:text-amber-300",
  },
  tool: {
    label: "Tool call",
    short: "Tool",
    bar: "bg-emerald-500 dark:bg-emerald-400",
    ring: "ring-emerald-500/40 dark:ring-emerald-400/40",
    chip: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  },
};

// ============================================================================
// Internal helpers
// ============================================================================

/** Gaps shorter than this never fold, however long the session. */
const FOLD_MIN_GAP_MS = 60_000;
/** ...and a gap must also be this share of the whole span to fold. */
const FOLD_SHARE = 0.12;
/** A folded gap is drawn at this share of the unfolded time. */
const BREAK_SHARE = 0.09;

function isRunToolDispatch(call: SessionToolCall): boolean {
  return readMcpToolCall(call).toolName === "run_tool";
}

const AUXILIARY_SOURCES = new Set<InteractionSource>([
  "opencode:subagent",
  "opencode:title",
  "opencode:compaction",
  "kilo:subagent",
  "kilo:title",
  "kilo:compaction",
  "chat:compaction",
  "a2a:compaction",
  "chat:title_generation",
  "chat:tool_call_repair",
  "a2a:tool_call_repair",
  "skill:description_generation",
  "guardrail:annotator",
  "knowledge:embedding",
  "knowledge:reranker",
  "knowledge:query-expansion",
  "knowledge:contextual-retrieval",
  "knowledge:ocr",
  "app:llm_complete",
  "app:recording_enhancement",
]);

/** "Called Grep, Read" for a tool step, or the reply's first line. */
function requestOutcome(
  row: Pick<InteractionSummary, "responseToolNames" | "responseTextPreview">,
): string | null {
  const tools = row.responseToolNames ?? [];
  if (tools.length > 0) {
    const names = tools.map(shortToolName);
    const shown = names.slice(0, MAX_LABEL_TOOLS).join(", ");
    const more = names.length - MAX_LABEL_TOOLS;
    return `Called ${shown}${more > 0 ? ` +${more}` : ""}`;
  }
  // Replies carry the same markdown and client tags as prompts do.
  return sessionTitleOf({ lastUserMessagePreview: row.responseTextPreview });
}

const MAX_LABEL_TOOLS = 3;
