import { createHash } from "node:crypto";
import { rewriteOrigin } from "./rewrite-projection";
import { assertRuntimeToolProofReplay } from "./runtime-tool-claims";
import { parseTrajectoryStamp } from "./trajectory-stamp";

export type RewriteWireFamily =
  | "anthropic:messages"
  | "openai:chatCompletions"
  | "openai:responses";

export type RewriteBytes = {
  key: string;
  original: Buffer;
  rewritten: Buffer;
};

/**
 * @public — live call holder captured before projection stamps rewriteOrigin.
 * Pass these to restoreRewriteCalls when the echo request may be cloned.
 */
export type RewriteEchoSource = {
  holder: Record<string, unknown>;
  parent?: Record<string, unknown>;
  id: string;
  bytes: Buffer;
};

type RewriteEchoErrorCode =
  | "duplicate-identity"
  | "missing-original"
  | "identity-reused"
  | "rewritten-mismatch"
  | "invalid-recorded"
  | "missing-record"
  | "alias-inconsistent"
  | "invalid-original"
  | "echo-mismatch"
  | "ambiguous-restore"
  | "text-mismatch"
  | "invalid-text"
  | "invalid-fragment";

/** @public — fixed code, message unchanged, never includes call bytes. */
export class RewriteEchoError extends Error {
  readonly code: RewriteEchoErrorCode;

  constructor(code: RewriteEchoErrorCode, message: string) {
    super(message);
    this.name = "RewriteEchoError";
    this.code = code;
  }
}

type RewriteTextSite = {
  value: string;
  holder: Record<string, unknown>;
  field: string;
  /** Tool output is subject to admission, not transport-only restoration. */
  toolResult: boolean;
};

export function captureRewriteEcho(params: {
  family: RewriteWireFamily;
  body: unknown;
}): {
  request: unknown;
  texts: RewriteTextSite[];
  hasCalls: boolean;
  sources: RewriteEchoSource[];
} {
  const sources: RewriteEchoSource[] = [];
  const calls = callSites(params).map((site) => {
    const bytes = encode(site.value);
    const token = {};
    Object.defineProperty(site.value, echoIdentity, {
      value: token,
      enumerable: true,
      configurable: true,
    });
    if (site.parent) {
      Object.defineProperty(site.value, echoParent, {
        value: site.parent,
        enumerable: true,
        configurable: true,
      });
    }
    sources.push({
      holder: site.value,
      ...(site.parent ? { parent: site.parent } : {}),
      id: site.id,
      bytes,
    });
    const clone = JSON.parse(bytes.toString("utf8")) as JsonRecord;
    Object.defineProperty(clone, echoSource, {
      value: site.value,
      enumerable: false,
      configurable: true,
    });
    return clone;
  });
  const request =
    params.family === "openai:responses"
      ? { input: calls }
      : params.family === "anthropic:messages"
        ? { messages: [{ role: "assistant", content: calls }] }
        : { messages: [{ role: "assistant", tool_calls: calls }] };
  return {
    request,
    texts: rewriteTextSites(params.body),
    hasCalls: calls.length > 0,
    sources,
  };
}

/** Enumerates only wire text holders, never arbitrary strings inside arguments. */
export function rewriteTextSites(body: unknown): RewriteTextSite[] {
  const root = record(body);
  if (!root) return [];
  const sites: RewriteTextSite[] = [];
  const messages: unknown[] = [];
  for (const field of ["messages", "input", "output"]) {
    if (Array.isArray(root[field])) messages.push(...root[field]);
  }
  if (Array.isArray(root.content)) messages.push(root);
  if (Array.isArray(root.choices))
    messages.push(...root.choices.map((choice) => record(choice)?.message));
  for (const value of messages) {
    const message = record(value);
    if (!message) continue;
    if (message.type === "compaction") {
      add(message, "encrypted_content", false);
      continue;
    }
    const toolResult =
      message.role === "tool" ||
      message.type === "function_call_output" ||
      message.type === "custom_tool_call_output";
    add(message, "content", toolResult);
    if (toolResult) add(message, "output", true);
    if (Array.isArray(message.content)) {
      for (const value of message.content) {
        const block = record(value);
        if (!block) continue;
        if (
          block.type === "text" ||
          block.type === "input_text" ||
          block.type === "output_text"
        )
          add(block, "text", toolResult);
        if (block.type === "tool_result") {
          add(block, "content", true);
          if (Array.isArray(block.content)) {
            for (const value of block.content) {
              const part = record(value);
              if (part?.type === "text") add(part, "text", true);
            }
          }
        }
      }
    }
  }
  return sites;

  function add(holder: JsonRecord, field: string, toolResult: boolean) {
    const value = holder[field];
    if (typeof value === "string")
      sites.push({ holder, field, value, toolResult });
  }
}

export function hasRewriteCarrier(text: string): boolean {
  return (
    /\[appa\] Protected by OpenAPPA\b/.test(text) ||
    text.includes("[appa] delegated trajectory ") ||
    text.includes("[appa] child trajectory ") ||
    text.includes("appac1-")
  );
}

/** Quoted transcript records are data, not live transport metadata. */
export function isQuotedHistory(text: string): boolean {
  const trimmed = text.trim();
  if (/^\[\d+\] tool [A-Za-z0-9_.:-]+ (?:call|result):/.test(trimmed)) {
    return true;
  }
  const lines = trimmed.split(/\r?\n/).filter((line) => line.trim() !== "");
  if (lines.length === 0) return false;
  try {
    const document = JSON.parse(trimmed) as unknown;
    return document !== null && typeof document === "object";
  } catch {
    return lines.every((line) => {
      try {
        const value = JSON.parse(line) as unknown;
        return value !== null && typeof value === "object";
      } catch {
        return false;
      }
    });
  }
}

export function replayCallKey(family: RewriteWireFamily, id: string): string {
  return callKey(family, id);
}

/** Only inserted delegation metadata can be restored across a parent boundary. */
export function recordedDelegationText(pair: RewriteBytes): Array<{
  original: string;
  rewritten: string;
  marker: string;
}> {
  const originals = strings(decodeRecord(pair.original));
  const rewritten = strings(decodeRecord(pair.rewritten));
  return rewritten.flatMap((value) => {
    if (!value.includes("[appa] delegated trajectory ")) return [];
    const matches = originals.filter(
      (original) =>
        value.startsWith(`${original}\n\n[appa] delegated trajectory `) &&
        !original.includes("[appa] delegated trajectory "),
    );
    return matches.length === 1
      ? [
          {
            original: matches[0],
            rewritten: value,
            marker: value.slice(matches[0].length),
          },
        ]
      : [];
  });
}

/** Captures before a response adapter or plugin can mutate the proposal. */
export function captureRewriteCalls(params: {
  family: RewriteWireFamily;
  response: unknown;
}): ReadonlyMap<string, Buffer> {
  const calls = new Map<string, Buffer>();
  for (const site of callSites({
    ...params,
    body: params.response,
    fromResponse: true,
  })) {
    if (calls.has(site.id))
      fail("duplicate-identity", "Duplicate replay call identity");
    calls.set(site.id, encode(site.value));
  }
  return calls;
}

export function rewriteCallKeys(params: {
  family: RewriteWireFamily;
  originals: ReadonlyMap<string, Buffer>;
}): string[] {
  return [...params.originals.keys()].map((id) => callKey(params.family, id));
}

/**
 * Stages immutable call pairs before the client receives executable bytes.
 * The caller must commit the returned batch before releasing the response.
 */
export function recordRewriteCalls(params: {
  family: RewriteWireFamily;
  response: unknown;
  originals: ReadonlyMap<string, Buffer>;
  emitted: readonly { id: string; wireId?: string }[];
  recorded: ReadonlyMap<string, RewriteBytes>;
}): RewriteBytes[] {
  const sources = new Map(
    params.emitted.map((call) => [call.wireId ?? call.id, call.id]),
  );
  const pending: RewriteBytes[] = [];
  for (const site of callSites({
    ...params,
    body: params.response,
    fromResponse: true,
  })) {
    const originalId = sources.get(site.id) ?? site.id;
    const original = params.originals.get(originalId);
    if (!original)
      fail(
        "missing-original",
        "Original provider call is unavailable for exact replay",
      );
    const key = callKey(params.family, originalId);
    const existing = params.recorded.get(key);
    if (existing && !existing.original.equals(original))
      fail(
        "identity-reused",
        "Provider reused a replay identity with different bytes",
      );
    if (existing && !existing.rewritten.equals(encode(site.value)))
      fail(
        "rewritten-mismatch",
        "APPA call differs from its recorded representation",
      );
    const pair = existing ?? {
      key,
      original,
      rewritten: encode(site.value),
    };
    const rewritten = decodeRecord(pair.rewritten);
    const rewrittenId = callId(params.family, rewritten);
    if (!rewrittenId) fail("invalid-recorded", "Invalid recorded replay call");
    replaceRecord(site.value, rewritten);
    if (!existing) pending.push(pair);
    pending.push({
      key: aliasKey(params.family, rewrittenId),
      original: Buffer.from(rewrittenId, "utf8"),
      rewritten: Buffer.from(key, "utf8"),
    });
  }
  return pending;
}

/** Alias reads are batched before fetching only the referenced call pairs. */
export function rewriteEchoKeys(params: {
  family: RewriteWireFamily;
  request: unknown;
}): string[] {
  return [
    ...new Set(
      callSites({ ...params, body: params.request }).flatMap((site) => [
        aliasKey(params.family, site.id),
        callKey(params.family, site.id),
      ]),
    ),
  ];
}

/**
 * Restore only after policy has consumed the client echo and its signed claims.
 * Call results keep their approved content; only their call reference changes.
 */
export function restoreRewriteCalls(params: {
  family: RewriteWireFamily;
  clientRequest: unknown;
  providerRequest: unknown;
  recorded: ReadonlyMap<string, RewriteBytes>;
  /** Live holders from captureRewriteEcho. Optional when clientRequest keeps them. */
  sources?: readonly RewriteEchoSource[];
}): ReadonlyMap<string, string> {
  const candidates = callSites({
    family: params.family,
    body: params.providerRequest,
  });
  const references = new Map<string, string>();
  for (const source of echoCalls(params)) {
    const alias = params.recorded.get(aliasKey(params.family, source.id));
    const pair = params.recorded.get(
      alias?.rewritten.toString("utf8") ?? callKey(params.family, source.id),
    );
    if (!pair) {
      if (alias || carriesRewrite(source.value))
        fail("missing-record", "Recorded APPA call is missing or expired");
      continue;
    }
    if (alias && alias.original.toString("utf8") !== source.id)
      fail("alias-inconsistent", "Recorded APPA call alias is inconsistent");
    const original = decodeRecord(pair.original);
    const rewritten = decodeRecord(pair.rewritten);
    const originalId = callId(params.family, original);
    if (!originalId) fail("invalid-original", "Invalid original replay call");
    const echoed = callFingerprint(params.family, source.value);
    if (
      echoed !== callFingerprint(params.family, rewritten) &&
      echoed !== callFingerprint(params.family, original) &&
      !stampedOriginalEcho({
        family: params.family,
        echoed: source.value,
        original,
      })
    )
      fail("echo-mismatch", "APPA call echo does not match its recorded bytes");
    const possibleIds = new Set([
      source.id,
      originalId,
      ...unstampedIds(source.id),
    ]);
    const matches = selectCandidate({
      source,
      candidates,
      possibleIds,
    });
    if (!matches)
      fail(
        "ambiguous-restore",
        "APPA call restoration is missing or ambiguous",
      );
    const target = matches.value;
    const preRestoreId = matches.id;
    const cacheControl = target.cache_control;
    replaceRecord(target, original);
    assertRuntimeToolProofReplay({
      role: "assistant",
      original: pair.original,
      restored: encode(target),
    });
    if (cacheControl !== undefined) target.cache_control = cacheControl;
    for (const id of possibleIds) references.set(id, originalId);
    references.set(preRestoreId, originalId);
    const holderId = callId(params.family, source.holder);
    if (holderId) references.set(holderId, originalId);
  }
  restoreResultReferences(params.providerRequest, references);
  return references;
}

/** Text pairs also cover receipt prefixes and opaque compaction carriers. */
export function rewriteTextKey(text: string): string {
  return `echo-text:v1:${hash(text)}`;
}

export function recordRewriteText(params: {
  original: string;
  rewritten: string;
}): RewriteBytes | undefined {
  if (params.original === params.rewritten) return undefined;
  return {
    key: rewriteTextKey(params.rewritten),
    original: encode(params.original),
    rewritten: encode(params.rewritten),
  };
}

export function restoreRewriteText(params: {
  text: string;
  recorded: ReadonlyMap<string, RewriteBytes>;
}): string | undefined {
  const pair = params.recorded.get(rewriteTextKey(params.text));
  if (!pair) return undefined;
  if (!pair.rewritten.equals(encode(params.text)))
    fail("text-mismatch", "Recorded APPA text does not match its identity");
  const original: unknown = JSON.parse(pair.original.toString("utf8"));
  if (typeof original !== "string")
    fail("invalid-text", "Invalid recorded APPA text");
  return original;
}

type JsonRecord = Record<string, unknown>;
type CallSite = { id: string; value: JsonRecord; parent?: JsonRecord };

function callSites(params: {
  family: RewriteWireFamily;
  body: unknown;
  fromResponse?: boolean;
}): CallSite[] {
  const body = record(params.body);
  if (!body) return [];
  const nodes: Array<{ node: unknown; parent?: JsonRecord }> = [];
  if (params.family === "openai:responses") {
    const items = body[params.fromResponse ? "output" : "input"];
    if (Array.isArray(items)) {
      for (const item of items) {
        const value = record(item);
        if (value?.role !== undefined && value.role !== "assistant") continue;
        if (
          value?.type === "function_call" ||
          value?.type === "custom_tool_call"
        )
          nodes.push({ node: item, parent: body });
      }
    }
  } else {
    const messages: unknown[] =
      !params.fromResponse && Array.isArray(body.messages)
        ? [...body.messages]
        : [];
    if (params.family === "anthropic:messages") {
      if (params.fromResponse && Array.isArray(body.content))
        messages.push(body);
      for (const message of messages) {
        const parent = record(message);
        // Stream response snapshots omit role; request messages never may.
        if (
          parent?.role !== "assistant" &&
          !(params.fromResponse && parent === body && parent.role === undefined)
        )
          continue;
        const content = parent?.content;
        if (!Array.isArray(content)) continue;
        for (const block of content) {
          if (record(block)?.type === "tool_use")
            nodes.push({ node: block, parent });
        }
      }
    } else {
      if (params.fromResponse && Array.isArray(body.choices))
        messages.push(...body.choices.map((choice) => record(choice)?.message));
      for (const message of messages) {
        const parent = record(message);
        if (parent?.role !== "assistant") continue;
        const calls = parent?.tool_calls;
        if (!Array.isArray(calls)) continue;
        for (const call of calls) nodes.push({ node: call, parent });
      }
    }
  }
  return nodes.flatMap(({ node, parent }) => {
    const value = record(node);
    const id = value && callId(params.family, value);
    return value && id ? [{ id, value, parent }] : [];
  });
}

function callId(
  family: RewriteWireFamily,
  call: JsonRecord,
): string | undefined {
  const id = family === "openai:responses" ? call.call_id : call.id;
  return typeof id === "string" && id.length > 0 ? id : undefined;
}

function stampedOriginalEcho(params: {
  family: RewriteWireFamily;
  echoed: JsonRecord;
  original: JsonRecord;
}): boolean {
  const echoedId = callId(params.family, params.echoed);
  const originalId = callId(params.family, params.original);
  if (!echoedId || !originalId) return false;
  if (!unstampedIds(echoedId).includes(originalId)) return false;
  return (
    argumentFingerprint(params.family, params.echoed) ===
    argumentFingerprint(params.family, params.original)
  );
}

function argumentFingerprint(
  family: RewriteWireFamily,
  call: JsonRecord,
): string {
  const fn = family === "openai:chatCompletions" ? record(call.function) : call;
  let args = family === "anthropic:messages" ? call.input : fn?.arguments;
  if (call.type === "custom_tool_call") args = call.input;
  if (typeof args === "string" && call.type !== "custom_tool_call") {
    try {
      args = JSON.parse(args);
    } catch {
      // Some providers return malformed arguments. They remain opaque bytes.
    }
  }
  return JSON.stringify([
    call.type,
    fn?.name,
    call.namespace ?? null,
    sorted(args),
  ]);
}

function callFingerprint(family: RewriteWireFamily, call: JsonRecord): string {
  const fn = family === "openai:chatCompletions" ? record(call.function) : call;
  let args = family === "anthropic:messages" ? call.input : fn?.arguments;
  if (call.type === "custom_tool_call") args = call.input;
  if (typeof args === "string" && call.type !== "custom_tool_call") {
    try {
      args = JSON.parse(args);
    } catch {
      // Some providers return malformed arguments. They remain opaque bytes.
    }
  }
  return JSON.stringify([
    callId(family, call),
    call.type,
    fn?.name,
    call.namespace ?? null,
    sorted(args),
  ]);
}

function carriesRewrite(call: JsonRecord): boolean {
  const id = call.call_id ?? call.id;
  if (typeof id === "string" && parseTrajectoryStamp(id)) return true;
  const args = callArguments(call);
  return (
    isNoticeCarrier(args) ||
    isRemedyCarrier(args) ||
    isOfferCarrier(args) ||
    hasDelegationMutation(args)
  );
}

function unstampedIds(id: string): string[] {
  const ids: string[] = [];
  // Identity lookup only. Authentication is done by the existing lineage gate.
  for (let depth = 0; depth < 4 && id.startsWith("appat1"); depth++) {
    const value = Buffer.from(id.slice(6, -22), "base64url").toString("utf8");
    const separator = value.indexOf("\0");
    if (separator < 0) break;
    id = value.slice(separator + 1);
    if (!id) break;
    ids.push(id);
  }
  return ids;
}

function restoreResultReferences(
  body: unknown,
  references: ReadonlyMap<string, string>,
): void {
  const root = record(body);
  if (!root) return;
  const messages = Array.isArray(root.messages) ? root.messages : [];
  const input = Array.isArray(root.input) ? root.input : [];
  for (const item of [...messages, ...input]) {
    const message = record(item);
    if (!message) continue;
    const nodes = [
      message,
      ...(Array.isArray(message.content) ? message.content : []),
    ];
    for (const node of nodes) {
      const result = record(node);
      if (!result) continue;
      const field =
        result.type === "tool_result"
          ? "tool_use_id"
          : result.type === "function_call_output" ||
              result.type === "custom_tool_call_output"
            ? "call_id"
            : result.role === "tool"
              ? "tool_call_id"
              : undefined;
      if (!field || typeof result[field] !== "string") continue;
      const restored = references.get(result[field]);
      if (restored) result[field] = restored;
    }
  }
}

function callKey(family: RewriteWireFamily, id: string): string {
  return `echo-call:v1:${family}:${hash(id)}`;
}

function aliasKey(family: RewriteWireFamily, id: string): string {
  return `echo-alias:v1:${family}:${hash(id)}`;
}

function hash(value: string): string {
  return createHash("sha256")
    .update(JSON.stringify(value), "utf8")
    .digest("hex");
}

function encode(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(value), "utf8");
}

function decodeRecord(value: Buffer): JsonRecord {
  const decoded = record(JSON.parse(value.toString("utf8")));
  if (!decoded) fail("invalid-fragment", "Invalid recorded APPA fragment");
  return decoded;
}

function record(value: unknown): JsonRecord | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : undefined;
}

function replaceRecord(target: JsonRecord, source: JsonRecord): void {
  for (const key of Object.keys(target)) delete target[key];
  Object.defineProperties(target, Object.getOwnPropertyDescriptors(source));
}

function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  const object = record(value);
  return object
    ? Object.fromEntries(
        Object.keys(object)
          .sort()
          .map((key) => [key, sorted(object[key])]),
      )
    : value;
}

const echoSource: unique symbol = Symbol("openappa.echoSource");
const echoIdentity: unique symbol = Symbol("openappa.echoIdentity");
const echoParent: unique symbol = Symbol("openappa.echoParent");

type EchoCall = {
  id: string;
  value: JsonRecord;
  holder: JsonRecord;
  parent?: JsonRecord;
};

function echoCalls(params: {
  family: RewriteWireFamily;
  clientRequest: unknown;
  sources?: readonly RewriteEchoSource[];
}): EchoCall[] {
  if (params.sources) {
    return params.sources.flatMap((source) => {
      const value = record(JSON.parse(source.bytes.toString("utf8")));
      return value
        ? [
            {
              id: source.id,
              value,
              holder: source.holder,
              ...(source.parent ? { parent: source.parent } : {}),
            },
          ]
        : [];
    });
  }
  return callSites({
    family: params.family,
    body: params.clientRequest,
  }).map((site) => {
    const holder = linkedHolder(site.value);
    const parent = parentOf(holder) ?? site.parent;
    return {
      id: site.id,
      value: site.value,
      holder,
      ...(parent ? { parent } : {}),
    };
  });
}

function selectCandidate(params: {
  source: EchoCall;
  candidates: CallSite[];
  possibleIds: ReadonlySet<string>;
}): CallSite | undefined {
  const byId = params.candidates.filter((site) =>
    params.possibleIds.has(site.id),
  );
  if (byId.length === 1) return byId[0];
  const identity = symbolValue(params.source.holder, echoIdentity);
  if (identity !== undefined) {
    const marked = params.candidates.filter(
      (site) => symbolValue(site.value, echoIdentity) === identity,
    );
    if (marked.length === 1) return marked[0];
  }
  const stamp =
    originStamp(params.source.holder) ??
    (params.source.parent ? originStamp(params.source.parent) : undefined);
  if (stamp !== undefined) {
    const stamped = params.candidates.filter(
      (site) =>
        originStamp(site.value) === stamp ||
        (site.parent ? originStamp(site.parent) === stamp : false),
    );
    if (stamped.length === 1) return stamped[0];
  }
  return undefined;
}

function linkedHolder(call: JsonRecord): JsonRecord {
  return record(symbolValue(call, echoSource)) ?? call;
}

function parentOf(call: JsonRecord): JsonRecord | undefined {
  return record(symbolValue(call, echoParent));
}

function symbolValue(value: JsonRecord, key: symbol): unknown {
  return (value as Record<symbol, unknown>)[key];
}

function originStamp(value: JsonRecord): unknown {
  return symbolValue(value, rewriteOrigin);
}

function callArguments(call: JsonRecord): unknown {
  if (call.type === "custom_tool_call") return call.input;
  const fn = record(call.function) ?? call;
  const args = fn.arguments ?? call.input;
  if (typeof args !== "string") return args;
  try {
    return JSON.parse(args);
  } catch {
    return undefined;
  }
}

function isNoticeCarrier(args: unknown): boolean {
  const value = record(args);
  const notice = record(value?.notice);
  if (!value || !notice || notice.v !== 1) return false;
  return (
    typeof notice.call_id === "string" &&
    notice.call_id.length > 0 &&
    typeof value.tool === "string" &&
    value.tool.length > 0 &&
    typeof value.ruling === "string" &&
    value.ruling.length > 0 &&
    value.arguments !== undefined
  );
}

function isRemedyCarrier(args: unknown): boolean {
  const execution = record(record(args)?.execution);
  if (!execution || execution.v !== 1 || execution.kind !== "appa_remedy")
    return false;
  return (
    typeof execution.call_id === "string" &&
    execution.call_id.length > 0 &&
    typeof execution.tool_name === "string" &&
    execution.tool_name.length > 0 &&
    typeof execution.original_arguments === "string"
  );
}

function isOfferCarrier(args: unknown): boolean {
  const offers = record(args)?.remedy_offers;
  return (
    Array.isArray(offers) &&
    offers.length > 0 &&
    offers.every((offer) => {
      const item = record(offer);
      return (
        typeof item?.protected === "string" &&
        item.protected.length > 0 &&
        typeof item?.payload === "string" &&
        item.payload.length > 0 &&
        typeof item?.signature === "string" &&
        item.signature.length > 0
      );
    })
  );
}

function hasDelegationMutation(args: unknown): boolean {
  return strings(args).some((value) =>
    value.includes("[appa] delegated trajectory "),
  );
}

function fail(code: RewriteEchoErrorCode, message: string): never {
  throw new RewriteEchoError(code, message);
}

function strings(value: unknown): string[] {
  if (typeof value === "string") {
    try {
      const decoded: unknown = JSON.parse(value);
      if (decoded && typeof decoded === "object") return strings(decoded);
    } catch {
      // Argument strings that are not JSON are ordinary leaf strings.
    }
    return [value];
  }
  if (Array.isArray(value)) return value.flatMap(strings);
  const object = record(value);
  return object ? Object.values(object).flatMap(strings) : [];
}
