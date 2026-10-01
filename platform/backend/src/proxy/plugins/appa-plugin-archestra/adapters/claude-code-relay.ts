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
 *
 * A text that holds more messages than Claude Code delivers at once, such as a
 * fetched page full of envelopes, is one arrival: it costs one decision.
 */
export function claudeCodeRelayArrivals(
  requestBody: unknown,
): AppaRelayArrival[] {
  const arrivals: AppaRelayArrival[] = [];
  for (const holder of textHolders(requestBody)) {
    const found: AppaRelayArrival[] = [];
    for (const envelope of ENVELOPES) {
      collectEnvelopes(holder, envelope, found);
    }
    collectCoordinatorMessages(holder, found);
    if (found.length > MAX_MESSAGES_PER_TEXT) {
      arrivals.push(crowdedText(holder));
    } else {
      arrivals.push(...found);
    }
  }
  return arrivals;
}

/**
 * Whether a message call's result is only the client's receipt for it. A
 * message to a stopped agent resumes that agent, and the result can then
 * carry the agent's final report, in its text or in a JSON receipt's
 * `message`: such a result is not a receipt.
 */
export function isClaudeCodeRelayReceipt(content: unknown): boolean {
  const text = resultText(content);
  // The proxy hands a result that is JSON text over parsed.
  const receipt =
    asRecord(content) ??
    (text === undefined ? undefined : asRecord(parseJson(text)));
  if (typeof receipt?.success === "boolean") {
    return (
      typeof receipt.message !== "string" ||
      resumedReport(receipt.message) === undefined
    );
  }
  if (text === undefined) return false;
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
  const text = resultText(content) ?? "";
  const receipt = asRecord(content) ?? asRecord(parseJson(text));
  const report = resumedReport(
    typeof receipt?.message === "string" ? receipt.message : text,
  );
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
  /**
   * The attributes Claude Code writes itself, each in the form it writes.
   * Any other attribute, such as the sender's own `summary`, is text no
   * record covers, so the model never reads it.
   */
  attributes: ReadonlyMap<string, RegExp>;
  pattern: RegExp;
  /** Claude Code's escape of this envelope's own tag inside a body. */
  escape: RegExp;
};

type Admission = { text: string; withheld: boolean };

/** Lookups over one list of records, built once for every message it admits. */
type RecordLookups = {
  /** The records as their sender sent them. */
  exact: ReadonlySet<string>;
  /** Each record, and each string a structured record carries. */
  texts: readonly string[];
  textSet: ReadonlySet<string>;
  /** The records as each envelope carries them, by envelope. */
  enveloped: Map<string, ReadonlySet<string>>;
};

/** A name Claude Code gives an agent, such as `team-lead` or `scout@session-1`. */
const AGENT_NAME = /^[A-Za-z0-9][A-Za-z0-9._@-]{0,63}$/;

/** A `<` and the characters Claude Code reads as one. */
const OPEN_BRACKETS = "<＜﹤〈⟨〈‹˂ᐸ❬❮❰⧼≮≺⋖";

const ENVELOPES: readonly Envelope[] = [
  envelope({
    tag: "teammate-message",
    kind: "teammate",
    from: "teammate_id",
    attributes: [
      ["teammate_id", AGENT_NAME],
      ["color", /^[a-z]{1,16}$/],
      ["verified", /^false$/],
    ],
  }),
  envelope({
    tag: "agent-message",
    kind: "agent",
    from: "from",
    attributes: [["from", AGENT_NAME]],
  }),
  // A message from another session never crosses, and neither does anything
  // its envelope says about its sender.
  envelope({
    tag: "cross-session-message",
    kind: "session",
    from: "from",
    attributes: [],
  }),
];

/** More messages than one delivery holds: the text is read as one arrival. */
const MAX_MESSAGES_PER_TEXT = 64;

const ATTRIBUTE = /([A-Za-z_-]+)="([^"]*)"/g;
const COORDINATOR =
  /The coordinator sent a message(?: while you were working)?:\n([\s\S]*?)\n\nAddress this before completing your current task\./g;
const HANDBACK_FRAME = /^\[Subagent hand-back\][^\n]*The report follows:\n/;
const HANDBACK_START = "[Subagent hand-back]";
const RESUMED_INLINE = /^Resumed agent[^\n]*Result:\n\n?([\s\S]*)$/;
const REMINDER_OPEN = "<system-reminder>";
const REMINDER_CLOSE = "</system-reminder>";
const HARNESS_NOTE = /^ {2}\[harness:[^\n]*\]\n(?: {2})?\n/;

/** Claude Code cuts a long result and ends it with one of these notes. */
const TRUNCATION_START = "\n[result truncated";
const TRUNCATION_NOTE =
  /^\n\[result truncated(?: — ask the agent for the rest via [A-Za-z_]{1,64})?\]$/;

/** Claude Code's rendering of a plan response: its feedback, or a default. */
const PLAN_RESPONSES = [
  {
    prefix: "[Plan Approved] ",
    fallback: "You can now proceed with implementation",
  },
  { prefix: "[Plan Rejected] ", fallback: "Please revise your plan" },
] as const;

/**
 * The note Claude Code appends to a shutdown request for its recipient. It
 * holds the exact input that approves the request, and no agent text. A note
 * in any other form is withheld.
 */
const SHUTDOWN_NOTE_START = "\n\nThis is a shutdown request.";
const SHUTDOWN_NOTE =
  /^\n\nThis is a shutdown request\. To approve it, call [A-Za-z_]{1,64} with exactly this input, where "message" is a JSON object rather than a string(?: and request_id is the request's requestId value, copied verbatim)?: (\{[^\n]{1,1024}\})\. Approving ends your process; a plain-text acknowledgment does not shut you down\. To decline, for example because you're mid-task, send the same input with "approve": false and a "reason"\.$/;
const SHUTDOWN_REQUEST_ID_PLACEHOLDER = "<requestId of the shutdown request>";

/** Structured team messages Claude Code writes. */
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

/**
 * The fields of a structured team message that Claude Code writes itself,
 * each in the form it writes. Every other string, such as a summary, a result,
 * or a key Claude Code never writes, is agent text and stands only when a
 * record covers it.
 */
const HARNESS_FIELDS: ReadonlyMap<string, RegExp> = new Map([
  ["type", /^[a-z_]{1,64}$/],
  ["from", AGENT_NAME],
  ["assignedBy", AGENT_NAME],
  [
    "timestamp",
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/,
  ],
  ["idleReason", /^(?:available|interrupted|failed)$/],
  ["completedStatus", /^(?:resolved|blocked|failed)$/],
  ["completedTaskId", /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/],
  ["taskId", /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/],
  ["requestId", /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/],
  ["paneId", /^[A-Za-z0-9%._:-]{1,64}$/],
  ["backendType", /^[A-Za-z][A-Za-z0-9_-]{0,31}$/],
  ["permissionMode", /^[A-Za-z]{1,32}$/],
  ["planFilePath", /^[A-Za-z0-9_.~/\\:@+-]{1,512}$/],
]);

const WITHHELD_MESSAGE =
  "[appa] Message withheld: this message has no record of crossing from its sender into this session, so its text is hidden.";
const WITHHELD_FIELD =
  "[appa] withheld: no record of crossing from its sender, so its text is hidden";
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

const RECORD_LOOKUPS = new WeakMap<readonly string[], RecordLookups>();

function envelope(params: {
  tag: string;
  kind: AppaRelayArrival["kind"];
  from: string;
  attributes: ReadonlyArray<readonly [string, RegExp]>;
}): Envelope {
  const { tag } = params;
  // Unicode mode admits escapes of syntax characters only, so a `-` stays bare.
  const name = [...tag]
    .map((character) => character.replace(/[\\^$.*+?()[\]{}|/]/g, "\\$&"))
    .join("[\\p{Cf}\\p{Mn}\\p{Me}]*");
  const filler = `[^A-Za-z0-9_\\-<>${OPEN_BRACKETS}]*`;
  return {
    tag,
    kind: params.kind,
    from: params.from,
    attributes: new Map(params.attributes),
    pattern: new RegExp(
      `<${tag}((?:[ \\t]+[A-Za-z_-]+="[^"]*")*)>\\n([\\s\\S]*?)\\n</${tag}>`,
      "g",
    ),
    escape: new RegExp(
      `[${OPEN_BRACKETS}](?!\\\\)(?=${filler}${name}(?:[^A-Za-z0-9_\\-]|$))`,
      "giu",
    ),
  };
}

function collectEnvelopes(
  holder: TextHolder,
  envelope: Envelope,
  arrivals: AppaRelayArrival[],
): void {
  for (const match of holder.get().matchAll(envelope.pattern)) {
    const [original, attributes = "", body = ""] = match;
    arrivals.push({
      kind: envelope.kind,
      from: parseAttributes(attributes)[envelope.from] ?? "",
      body,
      admit(records) {
        const admitted =
          envelope.kind === "session"
            ? { text: WITHHELD_MESSAGE, withheld: true }
            : admitBody({
                body,
                records: recordLookups(records),
                enveloped: envelopedRecords(records, envelope.tag, (value) =>
                  escapeEnvelopeBody(envelope, value),
                ),
              });
        const rendered = renderEnvelope(envelope, attributes, admitted.text);
        if (rendered !== original) replaceOnce(holder, original, rendered);
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
      body,
      admit(records) {
        const admitted = admitBody({
          body,
          records: recordLookups(records),
          enveloped: envelopedRecords(records, "coordinator", (value) =>
            // The notice rides a system reminder, whose closing tag is
            // escaped inside it.
            value.replaceAll("</system-reminder>", "&lt;/system-reminder&gt;"),
          ),
        });
        if (admitted.text !== body) {
          replaceOnce(
            holder,
            original,
            withCoordinatorBody(original, body, admitted.text),
          );
        }
        return { withheld: admitted.withheld };
      },
    });
  }
}

/**
 * A text crowded with messages, read as one arrival. Nothing on record covers
 * it whole, so it is withheld message by message in one pass.
 */
function crowdedText(holder: TextHolder): AppaRelayArrival {
  const text = holder.get();
  return {
    kind: "session",
    from: "",
    body: text,
    admit() {
      let withheld = text;
      for (const envelope of ENVELOPES) {
        withheld = withheld.replace(envelope.pattern, (_match, attributes) =>
          renderEnvelope(envelope, attributes ?? "", WITHHELD_MESSAGE),
        );
      }
      holder.set(
        withheld.replace(COORDINATOR, (original, body) =>
          withCoordinatorBody(original, body ?? "", WITHHELD_MESSAGE),
        ),
      );
      return { withheld: true };
    },
  };
}

/**
 * Admits a message body against the values its sender is on record for
 * sending here. A structured team message keeps its structure and loses only
 * the agent text no record covers.
 */
function admitBody(params: {
  body: string;
  records: RecordLookups;
  /** The retained values as the envelope carries them. */
  enveloped: ReadonlySet<string>;
}): Admission {
  const { body, records, enveloped } = params;
  const crossed = (text: string) =>
    records.exact.has(text) || enveloped.has(text);
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
 * A structured team message is harness text around agent text: its type, ids,
 * statuses, and times stand in the form Claude Code writes them, and every
 * other field stands only when a record covers it.
 */
function admitTeamProtocol(
  body: string,
  records: RecordLookups,
): Admission | undefined {
  const plan = PLAN_RESPONSES.find(({ prefix }) => body.startsWith(prefix));
  if (plan) {
    const feedback = body.slice(plan.prefix.length);
    return feedback === plan.fallback || coveredText(feedback, records)
      ? { text: body, withheld: false }
      : { text: `${plan.prefix}${WITHHELD_FIELD}`, withheld: true };
  }
  const noteAt = body.indexOf(SHUTDOWN_NOTE_START);
  const message = asRecord(
    parseJson(noteAt >= 0 ? body.slice(0, noteAt) : body),
  );
  if (
    !message ||
    typeof message.type !== "string" ||
    !LIFECYCLE_TYPES.has(message.type)
  ) {
    return undefined;
  }
  let withheld = false;
  const fields = Object.entries(message).map(([field, value]) => {
    if (admittedField(field, value, records)) return [field, value] as const;
    withheld = true;
    return [field, WITHHELD_FIELD] as const;
  });
  const note = noteAt >= 0 ? body.slice(noteAt) : "";
  const noteStands = note === "" || isShutdownNote(note, message);
  if (!withheld && noteStands) return { text: body, withheld: false };
  return {
    text: `${JSON.stringify(Object.fromEntries(fields))}${noteStands ? note : `\n\n${WITHHELD_FIELD}`}`,
    withheld: true,
  };
}

function admittedField(
  field: string,
  value: unknown,
  records: RecordLookups,
): boolean {
  if (value === null || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "string") return false;
  const form = HARNESS_FIELDS.get(field);
  if (form) return form.test(value);
  return value.length === 0 || coveredText(value, records);
}

/** Whether a shutdown note is the one Claude Code appends to this request. */
function isShutdownNote(
  note: string,
  request: Record<string, unknown>,
): boolean {
  const input = asRecord(parseJson(SHUTDOWN_NOTE.exec(note)?.[1] ?? ""));
  const response = asRecord(input?.message);
  if (request.type !== "shutdown_request" || !input || !response) return false;
  return (
    Object.keys(input).length === 2 &&
    typeof input.to === "string" &&
    AGENT_NAME.test(input.to) &&
    Object.keys(response).length === 3 &&
    response.type === "shutdown_response" &&
    response.approve === true &&
    (response.request_id === request.requestId ||
      response.request_id === SHUTDOWN_REQUEST_ID_PLACEHOLDER)
  );
}

/**
 * Whether agent text is a retained value: whole, or cut to Claude Code's
 * result limit and ended with one of its notes, and nothing after the note.
 */
function coveredText(value: string, records: RecordLookups): boolean {
  if (records.textSet.has(value)) return true;
  const unmarked = withoutChildReturnMarker(value);
  if (unmarked !== value && records.textSet.has(unmarked)) return true;
  const cut = value.lastIndexOf(TRUNCATION_START);
  if (cut <= 0 || !TRUNCATION_NOTE.test(value.slice(cut))) return false;
  const kept = value.slice(0, cut);
  return records.texts.some(
    (text) => text.length > kept.length && text.startsWith(kept),
  );
}

/**
 * Claude Code's escape of a message body inside its envelope: a `<` (or a
 * look-alike) that starts the envelope's own tag, opening or closing, becomes
 * `<\`, so a body can never close its envelope early.
 */
function escapeEnvelopeBody(envelope: Envelope, body: string): string {
  return body.replace(envelope.escape, "<\\");
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

/** The report a resumed agent's result carries, inline or in a hand-back frame. */
function resumedReport(text: string): string | undefined {
  const inline = RESUMED_INLINE.exec(text)?.[1];
  if (inline !== undefined) return inline;
  const frame = text.indexOf(HANDBACK_START);
  return frame >= 0 ? handbackReport(text.slice(frame)) : undefined;
}

function recordLookups(records: readonly string[]): RecordLookups {
  let lookups = RECORD_LOOKUPS.get(records);
  if (!lookups) {
    const texts = recordTexts(records);
    lookups = {
      exact: new Set(records),
      texts,
      textSet: new Set(texts),
      enveloped: new Map(),
    };
    RECORD_LOOKUPS.set(records, lookups);
  }
  return lookups;
}

function envelopedRecords(
  records: readonly string[],
  key: string,
  enveloped: (value: string) => string,
): ReadonlySet<string> {
  const lookups = recordLookups(records);
  let values = lookups.enveloped.get(key);
  if (!values) {
    values = new Set(records.map(enveloped));
    lookups.enveloped.set(key, values);
  }
  return values;
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

function renderEnvelope(
  envelope: Envelope,
  attributes: string,
  text: string,
): string {
  return `<${envelope.tag}${keptAttributes(envelope, attributes)}>\n${text}\n</${envelope.tag}>`;
}

/** The attributes Claude Code writes on this envelope, each kept once. */
function keptAttributes(envelope: Envelope, raw: string): string {
  const kept = new Set<string>();
  let rendered = "";
  for (const match of raw.matchAll(ATTRIBUTE)) {
    const [attribute, name = "", value = ""] = match;
    const form = envelope.attributes.get(name);
    if (!form || kept.has(name) || !form.test(unescapeAttribute(value))) {
      continue;
    }
    kept.add(name);
    rendered += ` ${attribute}`;
  }
  return rendered;
}

/** The coordinator notice with `text` in place of its message. */
function withCoordinatorBody(
  original: string,
  body: string,
  text: string,
): string {
  const start = original.indexOf(":\n") + 2;
  return `${original.slice(0, start)}${text}${original.slice(start + body.length)}`;
}

function parseAttributes(raw: string): Record<string, string> {
  const attributes: Record<string, string> = Object.create(null);
  for (const match of raw.matchAll(ATTRIBUTE)) {
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

/**
 * The text the tool itself wrote into its result. Claude Code appends its
 * reminders to the last result before a turn, as blocks of their own or at
 * the end of the text.
 */
function resultText(content: unknown): string | undefined {
  let text = contentText(content);
  for (
    let end = text?.trimEnd();
    end?.endsWith(REMINDER_CLOSE);
    end = text?.trimEnd()
  ) {
    const start = end.lastIndexOf(REMINDER_OPEN);
    if (start < 0) break;
    text = end.slice(0, start).trimEnd();
  }
  return text;
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
