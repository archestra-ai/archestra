/**
 * Delegation markers record child lineage in an allowed spawn call.
 *
 * Clients report child requests and spawner conversation IDs, but do not report
 * the parent's governed trajectory. Client data alone cannot bind nested child lineage.
 * When APPA allows a spawn call, it appends a signed marker line to the spawn prompt.
 * The child receives this marker in its opening message, and subsequent requests read it back.
 *
 * The signature covers the organization, caller, spawner conversation, and prompt text.
 * The marker cannot be moved to another conversation, caller, or prompt.
 * The proxy removes transport markers from message text and spawn prompts before provider dispatch.
 */
import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import config from "@/config";
import { type AppaWireFamily, chatMessages, responsesItems } from "./wire";

/** A marker read from a child's opening message, not yet verified. */
export type AppaDelegationMarker = {
  token: string;
  /** The spawner's trajectory, without the caller scope. */
  parentId: string;
  /** Digest of the text the marker closes. */
  promptDigest: string;
  /** Original provider call whose spawn opened this child. */
  spawnCallId?: string;
};

/** Creates and verifies markers only when the signing secret is set. */
export function delegationEnabled(): boolean {
  return config.openappa.offerSigningSecret.length > 0;
}

/**
 * Returns the marker line for a spawn call from `parentId`, or undefined when
 * markers are disabled.
 */
export function mintDelegationMarker(params: {
  organizationId: string;
  callerId: string | undefined;
  parentId: string;
  spawnerNativeId: string;
  /** The text the line is appended to; empty for a line that stands alone. */
  prompt: string;
  spawnCallId?: string;
}): string | undefined {
  const key = delegationKey();
  if (!key) return undefined;
  const nonce = randomBytes(NONCE_BYTES).toString("hex");
  const tag = delegationTag({
    key,
    organizationId: params.organizationId,
    callerId: params.callerId,
    parentId: params.parentId,
    spawnerNativeId: params.spawnerNativeId,
    promptDigest: digestOf(params.prompt),
    nonce,
    spawnCallId: params.spawnCallId,
  });
  const token = params.spawnCallId
    ? `appa2-${Buffer.from(params.spawnCallId).toString("base64url")}.${nonce}${tag}`
    : `appa-${nonce}${tag}`;
  return `${MARKER_PREFIX}${token} — child of ${params.parentId}.`;
}

/**
 * Returns true if this server signed `marker` for a spawn from `spawnerNativeId`
 * for this organization, caller, and prompt text.
 */
export function verifyDelegationMarker(params: {
  marker: AppaDelegationMarker;
  organizationId: string;
  callerId: string | undefined;
  spawnerNativeId: string;
}): boolean {
  const key = delegationKey();
  if (!key) return false;
  const token = parseMarkerToken(params.marker.token);
  if (!token) return false;
  if (params.marker.spawnCallId !== token.spawnCallId) return false;
  const actual = Buffer.from(token.tag, "utf8");
  // A line pushed as an item of its own closes no text, but a client may
  // still join it to the text before it.
  const digests = new Set([params.marker.promptDigest, EMPTY_PROMPT_DIGEST]);
  for (const promptDigest of digests) {
    const expected = Buffer.from(
      delegationTag({
        key,
        organizationId: params.organizationId,
        callerId: params.callerId,
        parentId: params.marker.parentId,
        spawnerNativeId: params.spawnerNativeId,
        promptDigest,
        nonce: token.nonce,
        spawnCallId: token.spawnCallId,
      }),
      "utf8",
    );
    if (actual.length === expected.length && timingSafeEqual(actual, expected))
      return true;
  }
  return false;
}

/** Matches exactly one marker line: the only text a finalizer can append to a call. */
export function isDelegationMarkerLine(text: string): boolean {
  return MARKER_LINE.test(text);
}

/** Exactly one marker, as the text item appended to an item list. */
export function isDelegationMarkerItem(value: unknown): boolean {
  const record = asRecord(value);
  return (
    record !== undefined &&
    Object.keys(record).length === 2 &&
    record.type === "text" &&
    typeof record.text === "string" &&
    isDelegationMarkerLine(record.text)
  );
}

/**
 * Collects markers from opening user messages in wire order.
 * Ignores system messages, tool results, and client notifications.
 * Only accepts a marker line at the end of the text.
 */
export function collectDelegationMarkers(params: {
  family: AppaWireFamily;
  body: unknown;
}): AppaDelegationMarker[] {
  return userTexts(params).flatMap((text) => {
    const marker = trailingMarker(text);
    return marker ? [marker] : [];
  });
}

/**
 * Removes all marker lines before provider dispatch.
 * Strips markers from model-visible text and supported spawn-call prompt fields
 * in assistant history. Arguments for other tools remain unchanged.
 * JSON spawn arguments are re-serialized only when their prompt field changes.
 */
export function stripDelegationMarkers(params: {
  family: AppaWireFamily;
  body: unknown;
}): void {
  if (params.family === "openai:responses") {
    const body = asRecord(params.body);
    if (typeof body?.input === "string") {
      const stripped = stripMarkerLines(body.input);
      if (stripped !== body.input)
        body.input = requiredTextAfterStrip(stripped);
    }
    if (body) stripTextContent(body, "instructions", "input_text", false);
    for (const item of responsesItems(params.body)) {
      if (item.type === "function_call") {
        stripSpawnArgumentText(item, spawnFields(item.name));
      } else if (item.type === "function_call_output") {
        stripTextContent(item, "output", "input_text", false);
      } else if (item.type === undefined || item.type === "message") {
        stripTextContent(item, "content", "input_text", item.role === "user");
      }
    }
    return;
  }
  const body = asRecord(params.body);
  if (params.family === "anthropic:messages" && body)
    stripTextContent(body, "system", "text", false);
  for (const message of chatMessages(params.body)) {
    stripTextContent(message, "content", "text", message.role === "user");
    if (params.family === "anthropic:messages") {
      for (const block of asArray(message.content) ?? []) {
        const record = asRecord(block);
        const input = asRecord(record?.input);
        if (record?.type === "tool_result")
          stripTextContent(record, "content", "text", false);
        if (record?.type === "tool_use" && input)
          stripSpawnArgumentFields(input, spawnFields(record.name));
      }
      continue;
    }
    if (message.role !== "assistant") continue;
    for (const call of asArray(message.tool_calls) ?? []) {
      const fn = asRecord(asRecord(call)?.function);
      if (fn) stripSpawnArgumentText(fn, spawnFields(fn.name));
    }
  }
}

// === Internal helpers ===

const MARKER_PREFIX = "[appa] delegated trajectory ";
const REMOVED_DELEGATION_TEXT = "[delegation metadata removed]";
const NONCE_BYTES = 8;
const TAG_HEX_LENGTH = 24;
const DELEGATION_KEY_LABEL = "archestra.appa.delegation.v1";
const MARKER_TOKEN = String.raw`(?:appa-[0-9a-f]{40}|appa2-[A-Za-z0-9_-]+\.[0-9a-f]{40})`;
// Clients can send lines with CRLF endings.
// Both regular expressions permit a carriage return at the end of the line.
const MARKER_LINE = new RegExp(
  String.raw`^\[appa\] delegated trajectory (${MARKER_TOKEN}) — child of ([^\n]+)\.\r?$`,
);
/** Every marker line, with the blank line APPA put before it. */
const MARKER_LINES = new RegExp(
  String.raw`(?:\r?\n\r?\n)?(?<=^|\n)\[appa\] delegated trajectory ${MARKER_TOKEN} — child of [^\n]+\.\r?(?=\n|$)`,
  "g",
);

function delegationKey(): Buffer | undefined {
  const secret = config.openappa.offerSigningSecret;
  if (secret.length === 0) return undefined;
  // Derives a distinct key so delegation tags cannot replace offer signatures
  // created with the same secret.
  return createHmac("sha256", secret).update(DELEGATION_KEY_LABEL).digest();
}

function delegationTag(params: {
  key: Buffer;
  organizationId: string;
  callerId: string | undefined;
  parentId: string;
  spawnerNativeId: string;
  promptDigest: string;
  nonce: string;
  spawnCallId?: string;
}): string {
  return createHmac("sha256", params.key)
    .update(
      JSON.stringify([
        params.spawnCallId ? "v2" : "v1",
        params.organizationId,
        params.callerId ?? "",
        params.parentId,
        params.spawnerNativeId,
        params.promptDigest,
        ...(params.spawnCallId ? [params.spawnCallId] : []),
        params.nonce,
      ]),
    )
    .digest("hex")
    .slice(0, TAG_HEX_LENGTH);
}

/** Clients may trim a prompt they pass on, so the digest ignores the ends. */
function digestOf(text: string): string {
  return createHash("sha256").update(text.trim()).digest("hex");
}

const EMPTY_PROMPT_DIGEST = digestOf("");

function trailingMarker(text: string): AppaDelegationMarker | undefined {
  if (!text.includes(MARKER_PREFIX)) return undefined;
  const trimmed = text.trimEnd();
  const lineStart = trimmed.lastIndexOf("\n") + 1;
  const match = MARKER_LINE.exec(trimmed.slice(lineStart));
  if (!match) return undefined;
  const token = parseMarkerToken(match[1]);
  if (!token) return undefined;
  return {
    token: match[1],
    parentId: match[2],
    promptDigest: digestOf(trimmed.slice(0, lineStart)),
    ...(token.spawnCallId ? { spawnCallId: token.spawnCallId } : {}),
  };
}

function parseMarkerToken(
  token: string,
): { nonce: string; tag: string; spawnCallId?: string } | undefined {
  if (token.startsWith("appa-")) {
    const body = token.slice("appa-".length);
    if (!/^[0-9a-f]{40}$/.test(body)) return undefined;
    return {
      nonce: body.slice(0, NONCE_BYTES * 2),
      tag: body.slice(NONCE_BYTES * 2),
    };
  }
  const match = /^appa2-([A-Za-z0-9_-]+)\.([0-9a-f]{40})$/.exec(token);
  if (!match) return undefined;
  const spawnCallId = Buffer.from(match[1], "base64url").toString("utf8");
  if (spawnCallId.length === 0) return undefined;
  return {
    spawnCallId,
    nonce: match[2].slice(0, NONCE_BYTES * 2),
    tag: match[2].slice(NONCE_BYTES * 2),
  };
}

function userTexts(params: {
  family: AppaWireFamily;
  body: unknown;
}): string[] {
  if (params.family === "openai:responses") {
    const input = asRecord(params.body)?.input;
    if (typeof input === "string") return [input];
    return responsesItems(params.body).flatMap((item) =>
      item.role === "user" &&
      (item.type === undefined || item.type === "message")
        ? contentTexts(item.content, "input_text")
        : [],
    );
  }
  return chatMessages(params.body).flatMap((message) => {
    if (message.role !== "user") return [];
    const blocks = asArray(message.content);
    if (blocks?.some((block) => asRecord(block)?.type === "tool_result"))
      return [];
    return contentTexts(message.content, "text");
  });
}

function contentTexts(content: unknown, partType: string): string[] {
  if (typeof content === "string") return [content];
  return (asArray(content) ?? []).flatMap((part) => {
    const record = asRecord(part);
    return record?.type === partType && typeof record.text === "string"
      ? [record.text]
      : [];
  });
}

function stripMarkerLines(text: string): string {
  return text.includes(MARKER_PREFIX) ? text.replace(MARKER_LINES, "") : text;
}

/**
 * Removes empty text parts because providers reject empty blocks.
 * If removal clears required user text, replaces it with placeholder text
 * so the provider receives a valid turn without the marker.
 */
function stripTextContent(
  holder: Record<string, unknown>,
  key: string,
  partType: string,
  preserveEmpty: boolean,
) {
  const content = holder[key];
  if (typeof content === "string") {
    const stripped = stripMarkerLines(content);
    if (stripped !== content)
      holder[key] = preserveEmpty ? requiredTextAfterStrip(stripped) : stripped;
    return;
  }
  const parts = asArray(content);
  if (!parts) return;
  let changed = false;
  let removedTextPart: Record<string, unknown> | undefined;
  const kept: unknown[] = [];
  for (const part of parts) {
    const record = asRecord(part);
    if (record?.type === partType && typeof record.text === "string") {
      const stripped = stripMarkerLines(record.text);
      if (stripped !== record.text) {
        changed = true;
        if (stripped.trim().length > 0)
          kept.push({ ...record, text: stripped });
        else removedTextPart ??= record;
        continue;
      }
    }
    kept.push(part);
  }
  if (!changed) return;
  if (kept.length === 0 && preserveEmpty && removedTextPart) {
    kept.push({ ...removedTextPart, text: REMOVED_DELEGATION_TEXT });
  }
  holder[key] = kept;
}

function spawnFields(name: unknown): readonly string[] {
  // A client's tools retain their names across provider protocols. OpenCode,
  // for example, sends `task` through both Chat Completions and Anthropic.
  const normalized = normalizedNativeToolName(name);
  if (normalized === "Agent" || normalized === "Task" || normalized === "task")
    return ["prompt"];
  if (normalized === "spawn_agent") return ["message", "items"];
  return [];
}

/** Normalizes native tool names without importing adapter helpers. */
function normalizedNativeToolName(name: unknown): string | undefined {
  if (typeof name !== "string") return undefined;
  const withoutFunctions = name.startsWith("functions.")
    ? name.slice("functions.".length)
    : name;
  for (const prefix of [
    "host/claude-code/",
    "host/archestra/",
    "builtin:",
    "host/",
  ]) {
    if (withoutFunctions.startsWith(prefix))
      return withoutFunctions.slice(prefix.length);
  }
  return withoutFunctions;
}

function requiredTextAfterStrip(stripped: string): string {
  return stripped.trim().length > 0 ? stripped : REMOVED_DELEGATION_TEXT;
}

/** Parses and re-serializes recognized spawn fields only when a field changes. */
function stripSpawnArgumentText(
  holder: Record<string, unknown>,
  fields: readonly string[],
) {
  const key = "arguments";
  const raw = holder[key];
  if (typeof raw !== "string" || !raw.includes(MARKER_PREFIX)) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return;
  }
  const args = asRecord(parsed);
  if (args && stripSpawnArgumentFields(args, fields))
    holder[key] = JSON.stringify(args);
}

function stripSpawnArgumentFields(
  args: Record<string, unknown>,
  fields: readonly string[],
): boolean {
  let changed = false;
  for (const field of fields) {
    if (field === "items") {
      const value = args[field];
      if (Array.isArray(value) && value.some(isDelegationMarkerItem)) {
        args[field] = value.filter((item) => !isDelegationMarkerItem(item));
        changed = true;
      }
      continue;
    }
    changed ||= stripTextArgument(args, field);
  }
  return changed;
}

function stripTextArgument(
  args: Record<string, unknown>,
  field: string,
): boolean {
  const value = args[field];
  if (typeof value !== "string") return false;
  const stripped = stripMarkerLines(value);
  if (stripped === value) return false;
  args[field] = stripped;
  return true;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asArray(value: unknown): unknown[] | undefined {
  return Array.isArray(value) ? value : undefined;
}
