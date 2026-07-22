import { HOOK_RUN_PART_TYPE } from "@archestra/shared";
import type { ChatMessage, ChatMessagePart } from "@/types";
import type { HookOutcome } from "@/types/hook";

/**
 * Re-exported so callers in this package keep importing it from here; the
 * canonical wire string lives in the shared module.
 *
 * @public — also imported directly by hook-run-parts.test.ts (knip --production
 * can't see test usage).
 */
export { HOOK_RUN_PART_TYPE };

/**
 * Where a hook-run entry attaches within an assistant turn. SessionStart sits at
 * the turn's start; PreToolUse / PostToolUse bracket the tool call they apply to
 * (matched by toolCallId); Stop sits at the end.
 */
export type HookRunAnchor =
  | { kind: "turn-start" }
  | { kind: "turn-end" }
  | { kind: "tool-pre"; toolCallId: string }
  | { kind: "tool-post"; toolCallId: string };

/**
 * Per-script result the dispatcher reports for one fired event. The dispatcher
 * knows the event + script + outcome; the caller assigns the lifecycle anchor
 * (it alone knows the toolCallId / turn position) to turn this into a
 * {@link CollectedHookRun}.
 */
export interface HookRunDetail {
  hookEventName: string;
  fileName: string;
  outcome: HookOutcome;
  exitCode: number | null;
  /** Raw stdout the hook wrote (untruncated; the part layer caps it). */
  stdout: string;
  /** Raw stderr the hook wrote (the block reason, untruncated). */
  stderr: string;
  /** Wall-clock duration of the hook run, in milliseconds. */
  durationMs: number;
  /** The JSON event payload the hook received on stdin. */
  payload: Record<string, unknown>;
}

/** A single hook execution collected during a turn, ready to render inline. */
export interface CollectedHookRun {
  /** Claude-style event name, e.g. "PreToolUse". */
  hookEventName: string;
  /** The hook script file, e.g. "guard.py". */
  fileName: string;
  outcome: HookOutcome;
  exitCode: number | null;
  /** Tool context for PreToolUse / PostToolUse entries (display only). */
  toolName?: string;
  /** Raw stdout the hook wrote (untruncated; the part layer caps it). */
  stdout: string;
  /** Raw stderr the hook wrote (the block reason, untruncated). */
  stderr: string;
  /** Wall-clock duration of the hook run, in milliseconds. */
  durationMs: number;
  /** The JSON event payload the hook received on stdin. */
  payload: Record<string, unknown>;
  anchor: HookRunAnchor;
}

/**
 * The data payload of a `data-hook-run` UI message part. The debug bodies
 * (`stdout` / `stderr` / `payloadJson` / `durationMs`) are optional so parts
 * persisted before this field set still deserialize, and `stdout` / `stderr`
 * are omitted when the hook wrote nothing. They are only ever delivered to the
 * client when the conversation has debug mode on and the viewer is an admin
 * (see {@link stripHookRunParts}); the model never sees any `data-*` part.
 */
interface HookRunPartData {
  hookEventName: string;
  fileName: string;
  outcome: HookOutcome;
  exitCode: number | null;
  toolName?: string;
  toolCallId?: string;
  stdout?: string;
  stderr?: string;
  /** The received payload, JSON-stringified and capped. */
  payloadJson?: string;
  durationMs?: number;
}

/** Build the model-invisible `data-hook-run` part for one collected run. */
function hookRunToPart(run: CollectedHookRun): ChatMessagePart {
  const data: HookRunPartData = {
    hookEventName: run.hookEventName,
    fileName: run.fileName,
    outcome: run.outcome,
    exitCode: run.exitCode,
  };
  if (run.toolName !== undefined) {
    data.toolName = run.toolName;
  }
  if (run.anchor.kind === "tool-pre" || run.anchor.kind === "tool-post") {
    data.toolCallId = run.anchor.toolCallId;
  }
  // Debug bodies: always carry the payload + duration; stdout / stderr only
  // when non-empty so silent hooks stay compact. All are capped so the
  // always-store model can't bloat a message row.
  data.payloadJson = truncate(JSON.stringify(run.payload));
  data.durationMs = run.durationMs;
  if (run.stdout) {
    data.stdout = truncate(run.stdout);
  }
  if (run.stderr) {
    data.stderr = truncate(run.stderr);
  }
  return { type: HOOK_RUN_PART_TYPE, data };
}

function isToolPartWithId(part: ChatMessagePart, toolCallId: string): boolean {
  if (part.toolCallId !== toolCallId) {
    return false;
  }
  return (
    typeof part.type === "string" &&
    (part.type.startsWith("tool-") || part.type === "dynamic-tool")
  );
}

/**
 * Splice `data-hook-run` parts into one assistant message's `parts[]` at the
 * positions their anchors describe. Pure: returns a new array, never mutates
 * the input (and returns the input as-is when there is nothing to splice).
 *
 * - `turn-start` runs go at the very top, in input order.
 * - `tool-pre` runs go immediately before the tool part with the matching
 *   `toolCallId`; `tool-post` immediately after it.
 * - `turn-end` runs are appended.
 * - A tool run whose `toolCallId` is not present in `parts` falls back to the
 *   very end (after `turn-end` runs) rather than being dropped.
 *
 * @public — used internally by {@link applyHookRunsToMessages} and exercised
 * directly by hook-run-parts.test.ts (knip --production can't see test usage).
 */
export function spliceHookRunParts(
  parts: ChatMessagePart[],
  runs: CollectedHookRun[],
): ChatMessagePart[] {
  if (runs.length === 0) {
    return parts;
  }

  const turnStart = runs.filter((r) => r.anchor.kind === "turn-start");
  const turnEnd = runs.filter((r) => r.anchor.kind === "turn-end");
  const toolRuns = runs.filter(
    (r) => r.anchor.kind === "tool-pre" || r.anchor.kind === "tool-post",
  );

  const matched = new Set<CollectedHookRun>();
  const out: ChatMessagePart[] = [];

  for (const run of turnStart) {
    out.push(hookRunToPart(run));
  }

  for (const part of parts) {
    for (const run of toolRuns) {
      if (
        run.anchor.kind === "tool-pre" &&
        !matched.has(run) &&
        isToolPartWithId(part, run.anchor.toolCallId)
      ) {
        out.push(hookRunToPart(run));
        matched.add(run);
      }
    }
    out.push(part);
    for (const run of toolRuns) {
      if (
        run.anchor.kind === "tool-post" &&
        !matched.has(run) &&
        isToolPartWithId(part, run.anchor.toolCallId)
      ) {
        out.push(hookRunToPart(run));
        matched.add(run);
      }
    }
  }

  for (const run of turnEnd) {
    out.push(hookRunToPart(run));
  }

  // Fallback: a tool run whose toolCallId never matched a part still surfaces,
  // appended at the end, so a positioning miss never silently drops an entry.
  for (const run of toolRuns) {
    if (!matched.has(run)) {
      out.push(hookRunToPart(run));
    }
  }

  return out;
}

/**
 * Map the dispatcher's per-script {@link HookRunDetail}s onto a lifecycle
 * anchor, producing {@link CollectedHookRun}s the chat layer accumulates over a
 * turn. `toolName` is carried for PreToolUse / PostToolUse display.
 */
export function toCollectedRuns(
  runs: HookRunDetail[] | undefined,
  anchor: HookRunAnchor,
  toolName?: string,
): CollectedHookRun[] {
  return (runs ?? []).map((r) => ({
    hookEventName: r.hookEventName,
    fileName: r.fileName,
    outcome: r.outcome,
    exitCode: r.exitCode,
    stdout: r.stdout,
    stderr: r.stderr,
    durationMs: r.durationMs,
    payload: r.payload,
    ...(toolName !== undefined ? { toolName } : {}),
    anchor,
  }));
}

/**
 * Remove every `data-hook-run` part from a conversation's messages unless
 * `visible`. This is the read-time gate: hook runs are persisted on every turn
 * (with their stdout / stderr / payload), but only delivered to the client when
 * the conversation has debug mode on AND the viewer is an admin. Pure — returns
 * the input as-is when visible or when no message carries a hook part, otherwise
 * returns shallow copies of only the messages that needed filtering.
 */
export function stripHookRunParts(
  messages: ChatMessage[],
  options: { visible: boolean },
): ChatMessage[] {
  if (options.visible) {
    return messages;
  }
  return messages.map((message) => {
    const parts = message.parts;
    if (!parts?.some((p) => p.type === HOOK_RUN_PART_TYPE)) {
      return message;
    }
    return {
      ...message,
      parts: parts.filter((p) => p.type !== HOOK_RUN_PART_TYPE),
    };
  });
}

/**
 * Attach collected hook runs to the assistant message(s) a turn just produced.
 * "This turn" is the run of assistant messages after the last user message in
 * `messages`. A tool-anchored run goes to whichever of those messages holds the
 * matching tool part (falling back to the last); turn-start goes to the first,
 * turn-end to the last. Returns `messages` unchanged — and never mutates it —
 * when the turn produced no assistant message (e.g. a blocked prompt), since
 * there is nothing to attach to.
 */
export function applyHookRunsToMessages(
  messages: ChatMessage[],
  runs: CollectedHookRun[],
): ChatMessage[] {
  if (runs.length === 0) {
    return messages;
  }

  let lastUserIdx = -1;
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === "user") {
      lastUserIdx = i;
    }
  }
  const assistantIdxs: number[] = [];
  for (let i = lastUserIdx + 1; i < messages.length; i++) {
    if (messages[i].role === "assistant") {
      assistantIdxs.push(i);
    }
  }
  if (assistantIdxs.length === 0) {
    return messages;
  }

  const firstIdx = assistantIdxs[0];
  const lastIdx = assistantIdxs[assistantIdxs.length - 1];

  // toolCallId -> index of the assistant message that holds that tool part.
  const toolIdxById = new Map<string, number>();
  for (const idx of assistantIdxs) {
    for (const part of messages[idx].parts ?? []) {
      if (
        typeof part.toolCallId === "string" &&
        typeof part.type === "string" &&
        (part.type.startsWith("tool-") || part.type === "dynamic-tool")
      ) {
        toolIdxById.set(part.toolCallId, idx);
      }
    }
  }

  const runsByIdx = new Map<number, CollectedHookRun[]>();
  const route = (idx: number, run: CollectedHookRun) => {
    const list = runsByIdx.get(idx);
    if (list) {
      list.push(run);
    } else {
      runsByIdx.set(idx, [run]);
    }
  };
  for (const run of runs) {
    if (run.anchor.kind === "turn-start") {
      route(firstIdx, run);
    } else if (run.anchor.kind === "turn-end") {
      route(lastIdx, run);
    } else {
      route(toolIdxById.get(run.anchor.toolCallId) ?? lastIdx, run);
    }
  }

  return messages.map((message, idx) => {
    const msgRuns = runsByIdx.get(idx);
    if (!msgRuns) {
      return message;
    }
    return {
      ...message,
      parts: spliceHookRunParts(message.parts ?? [], msgRuns),
    };
  });
}

// === internal ===

/**
 * Per-body cap for persisted hook stdout / stderr / payload. Deliberately below
 * the 50k PostToolUse `tool_response` cap so a single hook part stays bounded
 * (≤ ~3 × this) even though rich bodies are stored on every turn.
 */
const HOOK_DEBUG_BODY_CAP = 10_000;

/** Cap a string, appending a marker noting how many chars were dropped. */
function truncate(s: string, cap = HOOK_DEBUG_BODY_CAP): string {
  if (s.length <= cap) {
    return s;
  }
  return `${s.slice(0, cap)}…[truncated ${s.length - cap} chars]`;
}
