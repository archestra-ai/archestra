import { withoutChildReturnMarker } from "@/openappa/child-return";
import type { AppaRelayArrival } from "../types";
import { asRecord } from "./trajectory";

/**
 * The messages Claude Code delivers into a request from other agents:
 *
 * - `<teammate-message teammate_id=…>` between a lead and its teammates,
 * - `<agent-message from=…>` from a subagent to the main conversation,
 *   including a subagent's hand-back report,
 * - the coordinator notice that carries the main conversation's message to a
 *   background agent,
 * - `<cross-session-message …>` from another session.
 *
 * Claude Code puts them in user turns, merges queued ones into the preceding
 * tool result, and on some models moves them into a mid-conversation system
 * message, so every one of those places is read. Assistant turns only quote
 * them and are never read.
 */
export function claudeCodeRelayArrivals(
  requestBody: unknown,
): AppaRelayArrival[] {
  const arrivals: AppaRelayArrival[] = [];
  for (const holder of textHolders(requestBody)) {
    for (const envelope of ENVELOPES) {
      collectEnvelopes(holder, envelope, arrivals);
    }
    collectCoordinatorMessages(holder, arrivals);
  }
  return arrivals;
}

/**
 * Whether a message call's result is only the client's receipt for it. A
 * message to a stopped agent resumes that agent, and the result can then
 * carry the agent's final report: such a result is not a receipt.
 */
export function isClaudeCodeRelayReceipt(content: unknown): boolean {
  const text = contentText(content);
  if (text === undefined) return false;
  const receipt = asRecord(parseJson(text));
  if (typeof receipt?.success === "boolean") return true;
  return RELAY_RECEIPTS.some((pattern) => pattern.test(text));
}

/**
 * Admits the report a resumed agent's message call returned against the
 * values the session's children are on record for returning. A report no
 * record covers is withheld in the result the model reads.
 */
export function admitClaudeCodeRelayReport(
  content: unknown,
  records: readonly string[],
): { content: unknown; withheld: boolean } {
  const text = contentText(content) ?? "";
  const inline = /^Resumed agent[^\n]*Result:\n([\s\S]*)$/.exec(text)?.[1];
  const frame = text.indexOf("[Subagent hand-back]");
  const report =
    inline ?? (frame >= 0 ? handbackReport(text.slice(frame)) : undefined);
  const covered =
    report !== undefined &&
    records.some(
      (record) =>
        record === report || record === withoutChildReturnMarker(report),
    );
  return covered
    ? { content, withheld: false }
    : { content: WITHHELD_REPORT, withheld: true };
}

// ===

type TextHolder = { get(): string; set(value: string): void };

type Envelope = {
  tag: string;
  kind: AppaRelayArrival["kind"];
  /** The attribute that names the sender. */
  from: string;
};

const ENVELOPES: readonly Envelope[] = [
  { tag: "teammate-message", kind: "teammate", from: "teammate_id" },
  { tag: "agent-message", kind: "agent", from: "from" },
  { tag: "cross-session-message", kind: "session", from: "from" },
];

/** A `<` and the characters Claude Code reads as one. */
const OPEN_BRACKETS = "<＜﹤〈⟨〈‹˂ᐸ❬❮❰⧼≮≺⋖";

const COORDINATOR =
  /The coordinator sent a message(?: while you were working)?:\n([\s\S]*?)\n\nAddress this before completing your current task\./g;
const HANDBACK_FRAME = /^\[Subagent hand-back\][^\n]*The report follows:\n/;
const HARNESS_NOTE = /^ {2}\[harness:[^\n]*\]\n(?: {2})?\n/;
const TRUNCATION_NOTE = "[result truncated";
const SHUTDOWN_REQUEST_NOTE = "\n\nThis is a shutdown request.";
const PLAN_APPROVED = "[Plan Approved]";
const PLAN_REJECTED = "[Plan Rejected]";

/** Structured team messages Claude Code writes, and the fields that carry agent text. */
const LIFECYCLE_TYPES = new Set([
  "idle_notification",
  "task_assignment",
  "task_completed",
  "teammate_terminated",
  "shutdown_request",
  "shutdown_approved",
  "shutdown_rejected",
  "plan_approval_request",
  "plan_approval_response",
]);
const LIFECYCLE_TEXT_FIELDS = [
  "summary",
  "result",
  "reason",
  "failureReason",
  "planContent",
  "feedback",
  "description",
  "subject",
  "taskSubject",
  "message",
] as const;

const WITHHELD_MESSAGE =
  "[appa] Message withheld: this message has no record of crossing from its sender into this session.";
const WITHHELD_FIELD = "[appa] withheld: no record of crossing from its sender";
const WITHHELD_REPORT =
  "[appa] Report withheld: the resumed agent's report has no record of crossing into this session.";

/**
 * The receipts Claude Code returns for a message that carries nothing back:
 * delivered, queued, or refused. A JSON receipt with `success` is one too.
 */
const RELAY_RECEIPTS = [
  /^Message queued /,
  /^Resuming agent /,
  /^Teammate "[^"]*" (?:is already running|was not running)/,
  /^Shutdown (?:request sent|approved|rejected)/,
  /^Plan (?:approved|rejected) for /,
  /^No (?:agent|teammate) named /,
  /^Failed to write to /,
  /^You are the main conversation/,
  /^That agent cannot receive messages/,
  /^Structured team-protocol messages/,
  /^Cross-session messaging is not available/,
];

function collectEnvelopes(
  holder: TextHolder,
  envelope: Envelope,
  arrivals: AppaRelayArrival[],
): void {
  const pattern = new RegExp(
    `<${envelope.tag}((?:[ \\t]+[A-Za-z_-]+="[^"]*")*)>\\n([\\s\\S]*?)\\n</${envelope.tag}>`,
    "g",
  );
  for (const match of holder.get().matchAll(pattern)) {
    const [original, attributes = "", body = ""] = match;
    arrivals.push({
      kind: envelope.kind,
      from: parseAttributes(attributes)[envelope.from] ?? "",
      admit(records) {
        const admitted =
          envelope.kind === "session"
            ? { text: WITHHELD_MESSAGE, withheld: true }
            : admitBody({
                body,
                records,
                enveloped: (value) => escapeEnvelopeBody(envelope.tag, value),
              });
        if (admitted.text !== body) {
          replaceOnce(
            holder,
            original,
            `<${envelope.tag}${attributes}>\n${admitted.text}\n</${envelope.tag}>`,
          );
        }
        return { withheld: admitted.withheld };
      },
    });
  }
}

function collectCoordinatorMessages(
  holder: TextHolder,
  arrivals: AppaRelayArrival[],
): void {
  for (const match of holder.get().matchAll(COORDINATOR)) {
    const [original, body = ""] = match;
    arrivals.push({
      kind: "coordinator",
      from: "main",
      admit(records) {
        // The notice rides a system reminder, whose closing tag is escaped inside it.
        const admitted = admitBody({
          body,
          records,
          enveloped: (value) =>
            value.replaceAll("</system-reminder>", "&lt;/system-reminder&gt;"),
        });
        if (admitted.text !== body) {
          replaceOnce(holder, original, original.replace(body, admitted.text));
        }
        return { withheld: admitted.withheld };
      },
    });
  }
}

/**
 * Admits a message body against the values its sender is on record for
 * sending here. A structured team message keeps its structure and loses only
 * the agent text no record covers.
 */
function admitBody(params: {
  body: string;
  records: readonly string[];
  /** A retained value as its envelope carries it. */
  enveloped(value: string): string;
}): { text: string; withheld: boolean } {
  const { body, records, enveloped } = params;
  const crossed = (text: string) =>
    records.some((record) => enveloped(record) === text || record === text);
  if (crossed(body)) return { text: body, withheld: false };
  // A subagent's report carries the display marker after the crossed text.
  const unmarked = withoutChildReturnMarker(body);
  if (unmarked !== body && crossed(unmarked)) {
    return { text: body, withheld: false };
  }
  const report = handbackReport(body);
  if (report !== undefined && crossed(withoutChildReturnMarker(report))) {
    return { text: body, withheld: false };
  }
  return (
    admitTeamProtocol(body, records) ?? {
      text: WITHHELD_MESSAGE,
      withheld: true,
    }
  );
}

/**
 * Claude Code's escape of a message body inside its envelope: a `<` (or a
 * look-alike) that starts the envelope's own tag, opening or closing, becomes
 * `<\`, so a body can never close its envelope early.
 */
function escapeEnvelopeBody(tag: string, body: string): string {
  // Unicode mode admits escapes of syntax characters only, so a `-` stays bare.
  const name = [...tag]
    .map((character) => character.replace(/[\\^$.*+?()[\]{}|/]/g, "\\$&"))
    .join("[\\p{Cf}\\p{Mn}\\p{Me}]*");
  const filler = `[^A-Za-z0-9_\\-<>${OPEN_BRACKETS}]*`;
  return body.replace(
    new RegExp(
      `[${OPEN_BRACKETS}](?!\\\\)(?=${filler}${name}(?:[^A-Za-z0-9_\\-]|$))`,
      "giu",
    ),
    "<\\",
  );
}

/** The report inside a hand-back frame, with the frame's indentation removed. */
function handbackReport(body: string): string | undefined {
  const frame = HANDBACK_FRAME.exec(body);
  if (!frame) return undefined;
  const indented = body.slice(frame[0].length).replace(HARNESS_NOTE, "");
  return indented
    .split("\n")
    .map((line) => (line.startsWith("  ") ? line.slice(2) : line))
    .join("\n")
    .replace(/\n+$/, "");
}

/**
 * A structured team message is harness text around agent text: its type,
 * ids, and statuses stand, and each field an agent wrote stands only when a
 * record covers it.
 */
function admitTeamProtocol(
  body: string,
  records: readonly string[],
): { text: string; withheld: boolean } | undefined {
  if (body.startsWith(PLAN_APPROVED)) return { text: body, withheld: false };
  const texts = recordTexts(records);
  if (body.startsWith(PLAN_REJECTED)) {
    const covered = texts.some(
      (text) => text.length > 0 && body.includes(text),
    );
    return covered
      ? { text: body, withheld: false }
      : { text: `${PLAN_REJECTED} ${WITHHELD_FIELD}`, withheld: true };
  }
  const note = body.indexOf(SHUTDOWN_REQUEST_NOTE);
  const json = note >= 0 ? body.slice(0, note) : body;
  const message = asRecord(parseJson(json));
  if (
    !message ||
    typeof message.type !== "string" ||
    !LIFECYCLE_TYPES.has(message.type)
  ) {
    return undefined;
  }
  let withheld = false;
  const admitted: Record<string, unknown> = { ...message };
  for (const field of LIFECYCLE_TEXT_FIELDS) {
    const value = admitted[field];
    if (typeof value !== "string" || value.length === 0) continue;
    if (coveredText(value, texts)) continue;
    admitted[field] = WITHHELD_FIELD;
    withheld = true;
  }
  if (!withheld) return { text: body, withheld: false };
  return {
    text: `${JSON.stringify(admitted)}${note >= 0 ? body.slice(note) : ""}`,
    withheld: true,
  };
}

/** Each retained value, and each string a structured value carries. */
function recordTexts(records: readonly string[]): string[] {
  const texts: string[] = [];
  for (const record of records) {
    texts.push(record);
    const structured = asRecord(parseJson(record));
    for (const value of Object.values(structured ?? {})) {
      if (typeof value === "string") texts.push(value);
    }
  }
  return texts;
}

/** Whether agent text is a retained value, whole or cut to Claude Code's result limit. */
function coveredText(value: string, texts: readonly string[]): boolean {
  const unmarked = withoutChildReturnMarker(value);
  if (texts.some((text) => text === value || text === unmarked)) return true;
  const cut = value.lastIndexOf(TRUNCATION_NOTE);
  if (cut <= 0) return false;
  const kept = value.slice(0, cut).trimEnd();
  return kept.length > 0 && texts.some((text) => text.startsWith(kept));
}

function parseAttributes(raw: string): Record<string, string> {
  const attributes: Record<string, string> = Object.create(null);
  for (const match of raw.matchAll(/([A-Za-z_-]+)="([^"]*)"/g)) {
    const [, name, value = ""] = match;
    if (name) attributes[name] = unescapeAttribute(value);
  }
  return attributes;
}

function unescapeAttribute(value: string): string {
  return value
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");
}

function replaceOnce(
  holder: TextHolder,
  original: string,
  replacement: string,
): void {
  const text = holder.get();
  const index = text.indexOf(original);
  if (index < 0) return;
  holder.set(
    `${text.slice(0, index)}${replacement}${text.slice(index + original.length)}`,
  );
}

/** Every text a user turn, a tool result, or a mid-conversation system message carries. */
function* textHolders(requestBody: unknown): Generator<TextHolder> {
  const messages = asRecord(requestBody)?.messages;
  for (const message of Array.isArray(messages) ? messages : []) {
    const record = asRecord(message);
    if (!record || record.role === "assistant") continue;
    yield* contentHolders(record, "content");
  }
}

function* contentHolders(
  owner: Record<string, unknown>,
  key: string,
): Generator<TextHolder> {
  const content = owner[key];
  if (typeof content === "string") {
    yield {
      get: () => owner[key] as string,
      set: (value) => {
        owner[key] = value;
      },
    };
    return;
  }
  for (const block of Array.isArray(content) ? content : []) {
    const record = asRecord(block);
    if (!record) continue;
    if (record.type === "text" && typeof record.text === "string") {
      yield {
        get: () => record.text as string,
        set: (value) => {
          record.text = value;
        },
      };
    } else if (record.type === "tool_result") {
      yield* contentHolders(record, "content");
    }
  }
}

/** The text of a tool result: a string, or its text blocks joined. */
function contentText(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  const texts = content.flatMap((block) => {
    const record = asRecord(block);
    return record?.type === "text" && typeof record.text === "string"
      ? [record.text]
      : [];
  });
  return texts.length > 0 ? texts.join("\n") : undefined;
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}
