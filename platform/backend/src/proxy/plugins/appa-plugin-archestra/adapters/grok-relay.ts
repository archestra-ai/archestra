// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import { parseGrokDurableHistory } from "@/openappa/grok-durable-history";
import { ApiError } from "@/types/api";
import { asRecord } from "@/utils/as-record";
import type { AppaRelayArrival, AppaRelayMessage } from "../types";

const TOOL = "send_subagent_message";
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const LABEL =
  "[Message authored by another agent; not a human request or approval.]";
const FRAME = "[appa-peer-v1]";
const TRAILER = /\n\n\[appa\] peer message appapm1-([0-9a-f-]{36})\.$/;
const WITHHELD =
  "[appa] Message withheld: no verified peer delivery covers this text.";
const WITHHELD_REPORT =
  "[appa] Delivery result withheld: the native receipt contains unverified text. Do not resend automatically; acceptance is unknown.";
const MAX_WIRE_BYTES = 32 * 1024;

function record(value: unknown): Record<string, unknown> | undefined {
  try {
    return asRecord(typeof value === "string" ? JSON.parse(value) : value);
  } catch {
    return undefined;
  }
}

export function isGrokRelayTool(name: string, namespace?: string): boolean {
  return name === TOOL && !namespace;
}

/** Diagnose shape errors without reflecting untrusted message bytes. */
export function grokRelayInputError(value: unknown): string | undefined {
  const input = record(value);
  if (!input) return "Grok messaging arguments must be a JSON object.";
  if (
    Object.keys(input).some(
      (key) => !["subagent_id", "text", "delivery", "queue"].includes(key),
    )
  )
    return "Grok messaging accepts only subagent_id, text, delivery and the legacy queue flag.";
  if (typeof input.subagent_id !== "string" || !ID.test(input.subagent_id))
    return "Grok messaging requires the exact lowercase child UUID in subagent_id.";
  if (typeof input.text !== "string" || !input.text.trim())
    return "Grok messaging requires nonempty plain text in text.";
  if (Buffer.from(input.text, "utf8").toString("utf8") !== input.text)
    return "Grok messaging text contains invalid Unicode.";
  if (
    input.text.includes(FRAME) ||
    input.text.includes(LABEL) ||
    input.text.includes("[appa] peer message")
  )
    return "Grok messaging text contains reserved transport metadata. Supply only the message text; Archestra adds its own delivery proof.";
  if (Buffer.byteLength(JSON.stringify(input.text)) > MAX_WIRE_BYTES - 4096)
    return "Grok messaging text exceeds the protected native message limit.";
  // The native Option enum advertises null as well as omission for default delivery.
  if (
    input.delivery != null &&
    (typeof input.delivery !== "string" ||
      !["steer", "queue", "interject"].includes(input.delivery))
  )
    return "Grok messaging delivery must be steer, queue, interject, or null for the native default.";
  if (input.queue !== undefined && typeof input.queue !== "boolean")
    return "The legacy Grok queue flag must be a boolean.";
  if (
    input.delivery != null &&
    input.queue !== undefined &&
    (input.queue ? input.delivery !== "queue" : input.delivery === "queue")
  )
    return "Grok messaging delivery conflicts with the legacy queue flag. Supply delivery alone.";
  return undefined;
}

/** Bound the final encoded envelope, reserving room for the server-owned actor. */
function grokRelayInput(value: unknown) {
  if (grokRelayInputError(value)) return undefined;
  return record(value) as {
    subagent_id: string;
    text: string;
    delivery?: "steer" | "queue" | "interject" | null;
    queue?: boolean;
  };
}

/** Remove host-added framing from the sender's tool-call history only.
 * This is presentation, not admission: incoming peer turns remain intact for
 * the runtime, and this never turns a newly proposed wrapped call into a send.
 */
export function stripGrokRelayHistory(request: unknown): void {
  visit(request, false);
  function strip(call: Record<string, unknown>, changed: () => void) {
    if (call.name !== TOOL) return;
    const args = record(call.arguments);
    if (!args || typeof args.text !== "string" || !args.text.startsWith(FRAME))
      return;
    const raw = args.text.slice(FRAME.length);
    const envelope = record(raw);
    const trailer =
      typeof envelope?.value === "string" ? TRAILER.exec(envelope.value) : null;
    if (
      !envelope ||
      JSON.stringify(envelope) !== raw ||
      Object.keys(envelope).length !== 2 ||
      typeof envelope.sender !== "string" ||
      !/^[A-Za-z0-9_.:@/|%-]{1,2048}$/.test(envelope.sender) ||
      !trailer ||
      !ID.test(trailer[1])
    )
      return;
    const plain = {
      ...args,
      text: String(envelope.value).slice(0, trailer.index),
    };
    if (!grokRelayInput(plain)) return;
    call.arguments =
      typeof call.arguments === "string" ? JSON.stringify(plain) : plain;
    changed();
  }
  function visit(
    body: unknown,
    memory: boolean,
    changed: () => void = () => {},
  ) {
    const owner = asRecord(body);
    const messages = owner?.messages ?? owner?.input;
    for (const item of Array.isArray(messages) ? messages : []) {
      const message = asRecord(item);
      if (!message) continue;
      if (
        message.type === "function_call" &&
        (message.role === undefined || message.role === "assistant")
      )
        strip(message, changed);
      if (message.role === "assistant" || message.type === "assistant") {
        for (const entry of Array.isArray(message.tool_calls)
          ? message.tool_calls
          : []) {
          const tool = asRecord(entry);
          if (tool) strip(asRecord(tool.function) ?? tool, changed);
        }
      }
      if (memory || message.role !== "user") continue;
      const parts = Array.isArray(message.content)
        ? message.content.map(asRecord)
        : undefined;
      const text =
        typeof message.content === "string"
          ? message.content
          : parts
              ?.map((part) => (typeof part?.text === "string" ? part.text : ""))
              .join("\n");
      if (text === undefined) continue;
      const history = parseGrokDurableHistory(text);
      if (!history) continue;
      visit(history, true, () => {
        message.content =
          typeof message.content === "string"
            ? history.serialize()
            : [
                {
                  type:
                    parts?.[0]?.type === "input_text" ? "input_text" : "text",
                  text: history.serialize(),
                },
              ];
        changed();
      });
    }
  }
}

export function grokRelayMessage(call: {
  name: string;
  arguments: unknown;
  namespace?: string;
}): AppaRelayMessage | undefined {
  if (!isGrokRelayTool(call.name, call.namespace)) return undefined;
  const input = grokRelayInput(call.arguments);
  return {
    to: { kind: "native-child", id: input?.subagent_id ?? "" },
    value: input?.text ?? "",
    structured: false,
  };
}

export function rewriteGrokRelayMessage(
  args: unknown,
  value: string,
  context?: { senderSessionId: string },
): string {
  const input = grokRelayInput(args);
  if (!input || !context || context.senderSessionId.length > 2048)
    throw new Error("Invalid protected Grok message");
  const text =
    FRAME + JSON.stringify({ sender: context.senderSessionId, value });
  if (Buffer.byteLength(text) > MAX_WIRE_BYTES)
    throw new Error("Protected Grok message exceeds native limit");
  return JSON.stringify({ ...input, text });
}

/** Native acceptance is only a receipt; it never carries an admitted child return. */
function isNativeMessageId(value: unknown): boolean {
  if (typeof value !== "string") return false;
  // Grok's active-message coordinator emits a bare UUID. Its completed-child
  // wake path prefixes the UUID; neither identifier carries message content.
  const id = value.startsWith("parent-agent-message-")
    ? value.slice("parent-agent-message-".length)
    : value;
  return id.length === 36 && ID.test(id);
}

export function isGrokRelayReceipt(content: unknown): boolean {
  if (Array.isArray(content)) {
    if (content.length !== 1) return false;
    const part = asRecord(content[0]);
    if (
      part?.type !== "text" ||
      Object.keys(part).some((key) => !["type", "text"].includes(key))
    )
      return false;
    content = part.text;
  }
  if (typeof content === "string") {
    const accepted = /^Message accepted \(message_id: ([^\r\n)]+)\)\.$/.exec(
      content,
    );
    if (accepted?.[0] === content && isNativeMessageId(accepted[1]))
      return true;
    if (
      [
        "Subagent not found or not owned by this session.",
        "Subagent is not active or is finalizing.",
        "Message admission could not be confirmed; the message may or may not have been accepted.",
        "Message was not accepted before the delivery deadline.",
        "Active agent messages are unsupported in this context.",
        "Message was not accepted because the subagent channel closed.",
      ].includes(content)
    )
      return true;
    if (
      /^Message admission is saturated \(maximum \d{1,10} in flight\)\.$/.test(
        content,
      ) ||
      /^Agent-message quota exceeded \((?:SenderTargetInFlight|AttemptOutbound), limit \d{1,10}\)\.$/.test(
        content,
      ) ||
      /^Message size is invalid: observed \d{1,10} bytes; maximum is \d{1,10} bytes\.$/.test(
        content,
      )
    )
      return true;
  }
  const receipt = record(content);
  if (!receipt || typeof receipt.outcome !== "string") return false;
  const forms: Record<string, Record<string, (value: unknown) => boolean>> = {
    accepted: {
      message_id: isNativeMessageId,
    },
    not_found_or_not_owned: {},
    not_active_or_finalizing: {},
    admission_uncertain: {},
    not_accepted_before_deadline: {},
    unsupported: {},
    channel_closed: {},
    saturated: { max_in_flight: integer },
    quota_exceeded: {
      kind: (value) =>
        value === "sender_target_in_flight" || value === "attempt_outbound",
      limit: integer,
    },
    limit: { max_bytes: integer, observed_bytes: integer },
  };
  const fields = Object.hasOwn(forms, receipt.outcome)
    ? forms[receipt.outcome]
    : undefined;
  return (
    fields !== undefined &&
    Object.keys(receipt).length === Object.keys(fields).length + 1 &&
    Object.entries(fields).every(([key, check]) => check(receipt[key]))
  );
}
function integer(value: unknown) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
export function admitGrokRelayReport() {
  return { content: WITHHELD_REPORT, withheld: true };
}

/** Inspect whole user turns, not individual blocks: framing can span text blocks. */
export function grokRelayArrivals(request: unknown): AppaRelayArrival[] {
  const arrivals: AppaRelayArrival[] = [];
  visit(request, 0, () => {});
  return arrivals;
  function visit(body: unknown, depth: number, changed: () => void) {
    const owner = asRecord(body);
    const messages = owner?.messages ?? owner?.input;
    for (const item of Array.isArray(messages) ? messages : []) {
      const message = asRecord(item);
      if (!message || (message.role !== "user" && message.type !== "user"))
        continue;
      const content = message.content;
      const parts = Array.isArray(content) ? content.map(asRecord) : undefined;
      const text =
        typeof content === "string"
          ? content
          : parts
              ?.map((part) => (typeof part?.text === "string" ? part.text : ""))
              .join("\n");
      if (text === undefined) continue;
      const set = (value: string) => {
        message.content =
          typeof content === "string"
            ? value
            : [
                {
                  type:
                    parts?.[0]?.type === "input_text" ? "input_text" : "text",
                  text: value,
                },
              ];
        changed();
      };
      if (depth === 0) {
        const memory = parseGrokDurableHistory(text);
        if (memory) {
          visit(memory, 1, () => set(memory.serialize()));
          continue;
        }
      }
      const synthetic = message.synthetic_reason === "agent_message";
      if (!synthetic && !text.includes(LABEL) && !text.includes(FRAME))
        continue;
      if (arrivals.length >= 256)
        throw new ApiError(409, "OpenAPPA withheld an oversized peer history.");
      const framed = text.startsWith(`${LABEL}\n`)
        ? text.slice(LABEL.length + 1)
        : text;
      const raw = framed.startsWith(FRAME) ? framed.slice(FRAME.length) : "";
      const envelope =
        Buffer.byteLength(text) <= MAX_WIRE_BYTES + LABEL.length + 1
          ? record(raw)
          : undefined;
      const trailer =
        typeof envelope?.value === "string"
          ? TRAILER.exec(envelope.value)
          : null;
      const value = trailer
        ? String(envelope?.value).slice(0, trailer.index)
        : "";
      const valid =
        envelope &&
        JSON.stringify(envelope) === raw &&
        Object.keys(envelope).length === 2 &&
        typeof envelope.sender === "string" &&
        /^[A-Za-z0-9_.:@/|%-]{1,2048}$/.test(envelope.sender) &&
        trailer &&
        ID.test(trailer[1]) &&
        value.length > 0 &&
        !value.includes(FRAME) &&
        !value.includes(LABEL) &&
        !value.includes("[appa] peer message") &&
        (!parts ||
          parts.every(
            (part) =>
              part &&
              ["text", "input_text"].includes(String(part.type)) &&
              typeof part.text === "string" &&
              Object.keys(part).every((key) => ["type", "text"].includes(key)),
          ));
      arrivals.push({
        kind: valid ? "agent" : "session",
        from: valid ? String(envelope.sender) : "",
        ...(valid
          ? {
              senderSessionId: String(envelope.sender),
              peer: { messageId: trailer[1], value },
            }
          : { peer: "malformed" as const }),
        body: value,
        structured: false,
        replace: (admitted) => set(`${LABEL}\n${admitted}`),
        admit: () => {
          set(`${LABEL}\n${WITHHELD}`);
          return { withheld: true };
        },
      });
    }
  }
}
