import type { archestraApiTypes } from "@archestra/shared";
import {
  type RequestSpan,
  type Timeline,
  type TimelineSpan,
  toolCallSpanKey,
} from "./session-timeline";

export type SessionHandoffs =
  archestraApiTypes.GetLlmProxyLogSessionHandoffsResponses["200"];
type MoveKind = SessionHandoffs["moves"][number]["kind"];

/** Who held a stretch of the session's work. */
type Holder = "client" | "runtime";

export type RanOnSegment = {
  key: string;
  holder: Holder;
  /** The run that held this stretch; null for the client's. */
  runId: string | null;
  /**
   * The client's stretch seen from the run's own session: its requests live
   * in the client's session, so the stretch is only a placeholder here.
   */
  elsewhere: boolean;
  x0: number;
  x1: number;
  /** Epoch ms of the stretch. */
  start: number;
  end: number;
  requests: number;
  billed: number;
  /** Every request of the stretch was covered by a subscription plan. */
  subscription: boolean;
};

export type RanOnMove = {
  key: string;
  kind: MoveKind;
  /** The run the work moved to or from. */
  runId: string;
  x: number;
  at: number;
};

/** A move's knob in the row gutter, on the runtime lane's end. */
export type RanOnKnob = { kind: MoveKind; edge: "top" | "bottom" };

export type RanOnView = {
  /** "client": the session that handed work off; "runtime": a run's own. */
  side: Holder;
  segments: RanOnSegment[];
  moves: RanOnMove[];
  clientRequests: number;
  runtimeRequests: number;
  /** Spans that ran in Agent Runtime. */
  runtimeKeys: Set<string>;
  /** Where a move's knob sits in the row gutter, by span key. */
  knobs: Map<string, RanOnKnob>;
};

/**
 * Where a session's work ran, on its trace's axis. The client's session
 * splits at its moves (the handoff tool calls, when on this page); a run's
 * own session splits its rows at the pulls and steers and leaves the client's
 * stretch between them as a placeholder. Null when the session has no
 * handoff.
 */
export function buildRanOn({
  timeline,
  handoffs,
  sessionId,
}: {
  timeline: Timeline | null;
  handoffs: SessionHandoffs | undefined;
  sessionId: string;
}): RanOnView | null {
  if (!timeline || timeline.spans.length === 0 || !handoffs) return null;
  if (handoffs.handedTo.length > 0) {
    return clientView({
      timeline,
      handoffs,
      runtimeSessions: new Set(handoffs.handedTo.map((r) => r.llmSessionId)),
    });
  }
  if (handoffs.handedFrom?.llmSessionId === sessionId) {
    return runtimeView({
      timeline,
      handoffs,
      runId: handoffs.handedFrom.runId,
    });
  }
  return null;
}

/** Whether a span is the run's work, on the client's merged trace. */
export function ranInRuntime(
  span: TimelineSpan,
  runtimeSessions: Set<string>,
): boolean {
  const sessionId =
    span.type === "request" ? span.row.sessionId : span.call.sessionId;
  return sessionId !== null && runtimeSessions.has(sessionId);
}

// ===

function clientView({
  timeline,
  handoffs,
  runtimeSessions,
}: {
  timeline: Timeline;
  handoffs: SessionHandoffs;
  runtimeSessions: Set<string>;
}): RanOnView {
  const spans = timeline.spans;
  const runtimeKeys = new Set(
    spans
      .filter((span) => ranInRuntime(span, runtimeSessions))
      .map((s) => s.key),
  );
  const sessionOfRun = new Map(
    handoffs.handedTo.map((run) => [run.runId, run.llmSessionId]),
  );
  const requests = requestSpans(spans);
  const runtimeRows = requests.filter((s) => runtimeKeys.has(s.key));
  const last = Math.max(...spans.map((s) => s.end));

  // A move sits where its tool call ends, when that call is on this page;
  // otherwise at the first record after it.
  let cuts = handoffs.moves.map((move) => {
    const at = Date.parse(move.at);
    const call = spans.find(
      (s) => s.key === toolCallSpanKey(move.mcpToolCallId),
    );
    if (call) return { move, x: call.x + call.w, t: call.end };
    const next = spans.find((s) => s.start >= at);
    return { move, x: next ? next.x : 1, t: at };
  });
  // Without readable moves, the work went to the run when its first request
  // began.
  if (cuts.length === 0 && runtimeRows.length > 0) {
    const first = runtimeRows[0];
    cuts = [
      {
        move: {
          kind: "push",
          runId:
            handoffs.handedTo.find(
              (run) => run.llmSessionId === first.row.sessionId,
            )?.runId ?? handoffs.handedTo[0].runId,
          mcpToolCallId: first.key,
          at: new Date(first.start).toISOString(),
        },
        x: first.x,
        t: first.start,
      },
    ];
  }

  const edges: { x: number; t: number; runId: string | null }[] = [
    { x: 0, t: timeline.origin, runId: null },
    ...cuts.map((cut) => ({
      x: cut.x,
      t: cut.t,
      runId: cut.move.kind === "pull" ? null : cut.move.runId,
    })),
  ];
  const segments = edges.map((edge, i): RanOnSegment => {
    const next = edges[i + 1];
    const until = next ? next.t : Number.POSITIVE_INFINITY;
    const runSession = edge.runId ? sessionOfRun.get(edge.runId) : undefined;
    const rows = requests.filter(
      (s) =>
        s.start >= edge.t &&
        s.start < until &&
        (runSession ? s.row.sessionId === runSession : !runtimeKeys.has(s.key)),
    );
    return {
      key: `segment-${i}`,
      holder: edge.runId ? "runtime" : "client",
      runId: edge.runId,
      elsewhere: false,
      x0: edge.x,
      x1: next ? next.x : 1,
      start: edge.t,
      end: next ? next.t : last,
      ...rowStats(rows),
    };
  });
  const moves = cuts.map((cut) => ({
    key: cut.move.mcpToolCallId,
    kind: cut.move.kind,
    runId: cut.move.runId,
    x: cut.x,
    at: cut.t,
  }));
  return {
    side: "client",
    segments,
    moves,
    clientRequests: requests.length - runtimeRows.length,
    runtimeRequests: runtimeRows.length,
    runtimeKeys,
    knobs: knobsFor({ moves, runtimeSpans: runtimeRows }),
  };
}

function runtimeView({
  timeline,
  handoffs,
  runId,
}: {
  timeline: Timeline;
  handoffs: SessionHandoffs;
  runId: string;
}): RanOnView {
  const spans = timeline.spans;
  const requests = requestSpans(spans);
  const last = Math.max(...spans.map((s) => s.end));
  const events = handoffs.moves.map((move) => ({
    ...move,
    t: Date.parse(move.at),
  }));
  type Event = (typeof events)[number];
  // One stretch per push or steer, each ending at the next pull. Without
  // readable moves, the run held the work throughout.
  const windows: { from: Event | null; to: Event | null }[] = events.flatMap(
    (from, i) => {
      if (from.kind === "pull") return [];
      const to = events.slice(i + 1).find((e) => e.kind === "pull") ?? null;
      return [{ from, to }];
    },
  );
  if (windows.length === 0) windows.push({ from: null, to: null });

  const stretches = windows.map((w, i) => {
    const lo = i === 0 || !w.from ? Number.NEGATIVE_INFINITY : w.from.t;
    const hi = w.to ? w.to.t : Number.POSITIVE_INFINITY;
    const inside = spans.filter((s) => s.start >= lo && s.start < hi);
    return {
      ...w,
      x0:
        i === 0 || inside.length === 0
          ? 0
          : Math.min(...inside.map((s) => s.x)),
      x1:
        i === windows.length - 1 || inside.length === 0
          ? 1
          : Math.max(...inside.map((s) => s.x + s.w)),
      rows: requests.filter((s) => s.start >= lo && s.start < hi),
    };
  });

  const segments: RanOnSegment[] = [];
  const moves: RanOnMove[] = [];
  stretches.forEach((stretch, i) => {
    segments.push({
      key: `runtime-${i}`,
      holder: "runtime",
      runId,
      elsewhere: false,
      x0: stretch.x0,
      x1: stretch.x1,
      start: stretch.from?.t ?? timeline.origin,
      end: stretch.to ? stretch.to.t : last,
      ...rowStats(stretch.rows),
    });
    if (stretch.from) {
      moves.push({
        key: stretch.from.mcpToolCallId,
        kind: stretch.from.kind,
        runId,
        x: stretch.x0,
        at: stretch.from.t,
      });
    }
    if (!stretch.to) return;
    moves.push({
      key: stretch.to.mcpToolCallId,
      kind: "pull",
      runId,
      x: stretch.x1,
      at: stretch.to.t,
    });
    const next = stretches[i + 1];
    segments.push({
      key: `client-${i}`,
      holder: "client",
      runId: null,
      elsewhere: true,
      x0: stretch.x1,
      x1: next ? next.x0 : 1,
      start: stretch.to.t,
      end: next?.from ? next.from.t : last,
      requests: 0,
      billed: 0,
      subscription: false,
    });
  });
  return {
    side: "runtime",
    segments,
    moves,
    clientRequests: 0,
    runtimeRequests: requests.length,
    runtimeKeys: new Set(spans.map((s) => s.key)),
    knobs: knobsFor({ moves, runtimeSpans: requests }),
  };
}

/**
 * A push or steer opens the first runtime request after it; a pull closes
 * the last one before it.
 */
function knobsFor({
  moves,
  runtimeSpans,
}: {
  moves: RanOnMove[];
  runtimeSpans: RequestSpan[];
}): RanOnView["knobs"] {
  const knobs: RanOnView["knobs"] = new Map();
  for (const move of moves) {
    const span =
      move.kind === "pull"
        ? runtimeSpans.filter((s) => s.end <= move.at).at(-1)
        : runtimeSpans.find((s) => s.start >= move.at);
    if (span && !knobs.has(span.key)) {
      knobs.set(span.key, {
        kind: move.kind,
        edge: move.kind === "pull" ? "bottom" : "top",
      });
    }
  }
  return knobs;
}

function requestSpans(spans: TimelineSpan[]): RequestSpan[] {
  return spans.filter((s): s is RequestSpan => s.type === "request");
}

function rowStats(rows: RequestSpan[]) {
  const metered = rows.filter((s) => s.row.billingMode !== "subscription");
  return {
    requests: rows.length,
    billed: metered.reduce((sum, s) => sum + Number(s.row.cost ?? 0), 0),
    subscription: rows.length > 0 && metered.length === 0,
  };
}
