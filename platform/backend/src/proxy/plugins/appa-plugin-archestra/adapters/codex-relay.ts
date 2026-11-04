import { asRecord } from "@/utils/as-record";
import type { AppaRelayArrival, AppaRelayMessage } from "../types";

/**
 * Messages between the agents of one Codex session (multi-agent v2).
 *
 * Codex names each agent by its path, such as `/root` for the main agent and
 * `/root/worker` for the agent it started with the task name `worker`. An
 * agent sends a message with `collaboration.send_message`; the recipient gets
 * it as a `Message Type: MESSAGE` mailbox item. The text can be ciphertext
 * that only the model provider reads, and the item carries the same bytes as
 * the call, so a message crosses unchanged: it is never rewritten.
 */

/** The tool a Codex agent sends another agent a message with. */
const RELAY_TOOL = "send_message";
const RELAY_NAMESPACE = "collaboration";
const AGENT_PATH =
  /^\/[A-Za-z0-9_.@-]{1,128}(?:\/[A-Za-z0-9_.@-]{1,128}){0,15}$/;
const TASK_NAME = /^[A-Za-z0-9_.@-]{1,128}$/;
const MESSAGE_KIND = "MESSAGE";

const WITHHELD_REPORT =
  "[appa] Result withheld: OpenAPPA has no record of this message result, so its text is hidden.";
const WITHHELD_MESSAGE =
  "[appa] Message withheld: OpenAPPA cannot tell which agent of this session sent this message, so its text is hidden.";

/** True for the call that sends a message to another agent of the session. */
export function isCodexRelayTool(name: string, namespace?: string): boolean {
  return namespace === RELAY_NAMESPACE && name === RELAY_TOOL;
}

/**
 * Reads a `send_message` call. The recipient is the sender's parent (its
 * lead), one of its own children, or a sibling, by the name the sender's
 * parent started it with. Any other recipient is named as Codex names it, so
 * it is not found and the message is not sent.
 */
export function codexRelayMessage(
  call: { name: string; arguments: unknown; namespace?: string },
  requestBody: unknown,
): AppaRelayMessage | undefined {
  if (!isCodexRelayTool(call.name, call.namespace)) return undefined;
  const args = argumentRecord(call.arguments);
  const target = stringField(args?.target)?.trim() ?? "";
  const message = args?.message;
  const relation = target
    ? relationTo(codexAgentPath(requestBody), target)
    : undefined;
  return {
    to:
      relation?.kind === "lead"
        ? { kind: "lead" }
        : relation
          ? {
              kind: "teammate",
              name: relation.name,
              among: relation.kind === "child" ? "children" : "siblings",
            }
          : { kind: "teammate", name: target },
    // An empty or malformed message carries nothing to cross, and the
    // runtime refuses it: the call never stays open without a ruling.
    value: typeof message === "string" ? message : "",
    // The text can be ciphertext: it crosses byte for byte.
    structured: true,
  };
}

/**
 * A `send_message` result other than its empty receipt is withheld unless it
 * is a value this session's children are on record for returning.
 */
export function admitCodexRelayReport(
  content: unknown,
  records: readonly string[],
): { content: unknown; withheld: boolean } {
  const text =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content.map((part) => String(asRecord(part)?.text ?? "")).join("")
        : undefined;
  return text !== undefined && records.includes(text)
    ? { content, withheld: false }
    : { content: WITHHELD_REPORT, withheld: true };
}

/** `send_message` answers with an empty result: only its delivery receipt. */
export function isCodexRelayReceipt(content: unknown): boolean {
  if (typeof content === "string") return content.trim() === "";
  if (Array.isArray(content))
    return content.every((part) => {
      const record = asRecord(part);
      return (
        record !== undefined &&
        typeof record.text === "string" &&
        record.text.trim() === ""
      );
    });
  return false;
}

/**
 * The messages other agents of the session delivered into this request: its
 * `Message Type: MESSAGE` mailbox items. A message from the sender's parent
 * is the coordinator's; from a child or a sibling, an agent's or a
 * teammate's, by task name. A message this agent is not the recipient of, or
 * whose sender is none of those, is from another session.
 */
export function codexRelayArrivals(requestBody: unknown): AppaRelayArrival[] {
  const input = asRecord(requestBody)?.input;
  if (!Array.isArray(input)) return [];
  const own = codexAgentPath(requestBody);
  const arrivals: AppaRelayArrival[] = [];
  for (const value of input) {
    const item = asRecord(value);
    if (item?.type !== "agent_message") continue;
    const message = readMessage(item);
    if (!message) continue;
    const relation =
      own && message.recipient === own
        ? relationTo(own, message.author)
        : undefined;
    arrivals.push(arrival(item, message, relation));
  }
  return arrivals;
}

/** The path of the agent a request is for, from its Codex turn metadata. */
function codexAgentPath(requestBody: unknown): string | undefined {
  const metadata = asRecord(asRecord(requestBody)?.client_metadata);
  const raw = metadata?.["x-codex-turn-metadata"];
  const turn =
    typeof raw === "string" ? asRecord(parseJson(raw)) : asRecord(raw);
  const path = stringField(turn?.agent_name);
  return path && AGENT_PATH.test(path) ? path : undefined;
}

// ===

type Relation = { kind: "lead" } | { kind: "child" | "sibling"; name: string };

type MailboxMessage = {
  author: string;
  recipient: string;
  header: string;
  body: string;
  /** The content as the client sent it. */
  content: unknown[];
};

/** How `other`, as `own` names it, relates to the agent at path `own`. */
function relationTo(
  own: string | undefined,
  other: string,
): Relation | undefined {
  if (!own) return undefined;
  const target = other.startsWith("/")
    ? other
    : TASK_NAME.test(other)
      ? `${own}/${other}`
      : undefined;
  if (!target || !AGENT_PATH.test(target) || target === own) return undefined;
  const lead = parentPath(own);
  if (lead && target === lead) return { kind: "lead" };
  const targetParent = parentPath(target);
  const name = target.slice(target.lastIndexOf("/") + 1);
  if (targetParent === own) return { kind: "child", name };
  if (lead && targetParent === lead) return { kind: "sibling", name };
  return undefined;
}

function parentPath(path: string): string | undefined {
  const index = path.lastIndexOf("/");
  return index > 0 ? path.slice(0, index) : undefined;
}

/**
 * A mailbox item of kind MESSAGE: its header names the recipient and the
 * sender as the item does, and its payload is one encrypted part or text.
 * Any other item is not a message between agents; the mailbox reader rules
 * on it.
 */
function readMessage(
  item: Record<string, unknown>,
): MailboxMessage | undefined {
  const parts = Array.isArray(item.content) ? item.content : [];
  const first = asRecord(parts[0]);
  const text =
    first?.type === "input_text" ? stringField(first.text) : undefined;
  if (!text?.match(/^Message Type: MESSAGE\r?\n/)) return undefined;
  const author = stringField(item.author) ?? "";
  const recipient = stringField(item.recipient) ?? "";
  const header = ["\n", "\r\n"]
    .map((newline) =>
      [
        `Message Type: ${MESSAGE_KIND}`,
        `Task name: ${recipient}`,
        `Sender: ${author}`,
        "Payload:",
        "",
      ].join(newline),
    )
    .find((prefix) => text.startsWith(prefix));
  const content = [...parts];
  const encrypted = asRecord(parts[1]);
  const body =
    header === undefined
      ? undefined
      : parts.length === 2 &&
          text === header &&
          encrypted?.type === "encrypted_content" &&
          typeof encrypted.encrypted_content === "string"
        ? encrypted.encrypted_content
        : parts.every(
              (part) =>
                asRecord(part)?.type === "input_text" &&
                typeof asRecord(part)?.text === "string",
            )
          ? parts
              .map((part) => String(asRecord(part)?.text))
              .join("")
              .slice(header.length)
          : undefined;
  return {
    author,
    recipient,
    header: header ?? `Message Type: ${MESSAGE_KIND}\nPayload:\n`,
    // A message whose shape this does not read has no body any record holds.
    body: body ?? "",
    content,
  };
}

function arrival(
  item: Record<string, unknown>,
  message: MailboxMessage,
  relation: Relation | undefined,
): AppaRelayArrival {
  const replace = (text: string) => {
    item.content =
      message.body !== "" && text === message.body
        ? message.content
        : [{ type: "input_text", text: message.header + text }];
  };
  const recorded = (records: readonly string[]) =>
    message.body !== "" && records.includes(message.body);
  return {
    kind:
      relation?.kind === "lead"
        ? "coordinator"
        : relation?.kind === "child"
          ? "agent"
          : relation?.kind === "sibling"
            ? "teammate"
            : "session",
    from:
      relation === undefined || message.body === ""
        ? ""
        : relation.kind === "lead"
          ? message.author
          : relation.name,
    ...(relation?.kind === "child" || relation?.kind === "sibling"
      ? { sender: relation.kind }
      : {}),
    body: message.body,
    structured: true,
    recorded,
    admit(records) {
      if (recorded(records)) return { withheld: false };
      replace(WITHHELD_MESSAGE);
      return { withheld: true };
    },
    replace,
  };
}

function argumentRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "string"
    ? asRecord(parseJson(value))
    : asRecord(value);
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
