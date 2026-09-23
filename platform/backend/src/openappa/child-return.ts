import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { TextDecoder } from "node:util";
import config from "@/config";
import { parseTrajectoryStamp } from "@/openappa/trajectory-stamp";
import { ApiError } from "@/types";

export type AppaChildReturnReceipt = {
  /** Self-contained authenticated machine token (`appar-...`). */
  token: string;
  /** Human-facing compact code. Never used as authority. */
  displayCode: string;
  value: string;
  childNativeId?: string;
  spawnCallId?: string;
  envelopeId?: string;
  /** This exact occurrence came from assistant-authored history. */
  assistantOrigin: boolean;
};

export type AppaChildReturnCompletion = {
  value: string;
  childNativeId?: string;
  spawnCallId?: string;
  envelopeId?: string;
  assistantOrigin: boolean;
  receipt?: AppaChildReturnReceipt;
};

export type CollectedChildReturns = {
  /** Every receipt occurrence. The same token can appear more than once. */
  receipts: AppaChildReturnReceipt[];
  /** Every structured completed leaf, including leaves without a receipt. */
  completions: AppaChildReturnCompletion[];
};

type VerifiedChildReturnReceipt = {
  token: string;
  organizationId: string;
  callerId?: string;
  parentId: string;
  childId: string;
  childNativeId?: string;
  spawnCallId?: string;
  value: string;
  envelopeId?: string;
  assistantOrigin: boolean;
};

export function mintChildReturnReceipt(params: {
  organizationId: string;
  callerId: string | undefined;
  parentId: string;
  childId: string;
  childNativeId?: string;
  spawnCallId?: string;
  value: string;
  format?: "full" | "inline";
}): string | undefined {
  const key = receiptKey();
  if (!key) return undefined;
  const valueHash = hashValue(params.value);
  const claims: ChildReturnClaims = [
    PROOF_VERSION,
    params.organizationId,
    params.callerId ?? null,
    params.parentId,
    params.childId,
    params.childNativeId ?? null,
    params.spawnCallId ?? null,
    valueHash,
  ];
  const payload = encodeClaims(claims);
  const mac = proofMac({ key, payload });
  const token = `${MACHINE_TOKEN_PREFIX}${payload}.${mac}`;
  const displayCode = encodeCrockford35(first35Bits(Buffer.from(mac, "hex")));
  return formatReceipt({ token, displayCode, format: params.format });
}

/** Verifies one self-contained child-return proof without storage or cache. */
export function verifyChildReturnReceipt(params: {
  receipt: AppaChildReturnReceipt;
  organizationId: string;
  callerId: string | undefined;
  parentId: string;
}): VerifiedChildReturnReceipt | null {
  const key = receiptKey();
  if (!key) return null;
  const claims = verifyProof({ token: params.receipt.token, key });
  if (!claims) return null;
  const [
    ,
    organizationId,
    callerId,
    parentId,
    childId,
    childNativeId,
    spawnCallId,
    valueHash,
  ] = claims;
  if (
    organizationId !== params.organizationId ||
    callerId !== (params.callerId ?? null)
  ) {
    return null;
  }
  const roleMatches = params.receipt.assistantOrigin
    ? childId === params.parentId
    : parentId === params.parentId;
  if (!roleMatches) return null;
  if (
    params.receipt.childNativeId &&
    childNativeId &&
    params.receipt.childNativeId !== childNativeId
  ) {
    return null;
  }
  if (
    params.receipt.spawnCallId &&
    normalizeCallId(params.receipt.spawnCallId) !== normalizeCallId(spawnCallId)
  ) {
    return null;
  }
  if (!safeEqual(hashValue(params.receipt.value), valueHash)) return null;
  const correlatedNativeId =
    childNativeId ??
    (spawnCallId && params.receipt.spawnCallId
      ? params.receipt.childNativeId
      : undefined);
  return {
    token: params.receipt.token,
    organizationId,
    ...(callerId ? { callerId } : {}),
    parentId,
    childId,
    ...(correlatedNativeId ? { childNativeId: correlatedNativeId } : {}),
    ...(spawnCallId ? { spawnCallId } : {}),
    value: params.receipt.value,
    ...(params.receipt.envelopeId
      ? { envelopeId: params.receipt.envelopeId }
      : {}),
    assistantOrigin: params.receipt.assistantOrigin,
  };
}

/**
 * Extracts and removes child-return carriers before provider dispatch.
 * Records each structured completion leaf separately, including unsigned leaves.
 * This makes sure a signed child return cannot cover an unsigned sibling return.
 */
export function collectAndStripChildReturns(
  body: unknown,
): CollectedChildReturns {
  const collected: CollectedChildReturns = {
    receipts: [],
    completions: [],
  };
  const nativeResultCallIds = collectNativeResultCallIds(body);

  const walk = (
    value: unknown,
    context: WalkContext = DEFAULT_CONTEXT,
  ): unknown => {
    if (typeof value === "string") {
      const parsedJson = context.nativeResultSite
        ? jsonContainer(value)
        : undefined;
      if (parsedJson !== undefined) {
        const record = asRecord(parsedJson);
        const status = asRecord(record?.status);
        const canonical = status
          ? canonicalizeStatus(status, context, collected)
          : undefined;
        if (canonical) {
          return JSON.stringify({ status: canonical });
        }
      }

      let rewritten = value;
      if (
        isStandaloneEnvelope(value, TASK_NOTIFICATION) ||
        (context.nativeResultSite &&
          startsWithEnvelope(value, TASK_NOTIFICATION))
      ) {
        rewritten = replaceTaskNotifications(value, context, collected);
      } else if (
        isStandaloneEnvelope(value, SUBAGENT_NOTIFICATION) ||
        (context.nativeResultSite &&
          startsWithEnvelope(value, SUBAGENT_NOTIFICATION))
      ) {
        rewritten = replaceSubagentNotifications(value, context, collected);
      } else if (
        context.nativeResultSite &&
        isCompleteTaskResultFraming(value)
      ) {
        rewritten = replaceTaskResults(value, context, collected);
      } else if (context.nativeResultSite) {
        rewritten = replaceAgentReport(value, context, collected);
      }
      if (rewritten !== value) return rewritten;
      if (!context.nativeResultSite && !context.assistantOrigin) return value;
      const parsed = stripReceipt(value, context);
      if (!parsed.receipt) return value;
      collected.receipts.push(parsed.receipt);
      return parsed.value;
    }
    if (Array.isArray(value)) {
      return value.map((entry) => walk(entry, { ...context, topLevel: false }));
    }
    const record = asRecord(value);
    if (!record) return value;

    const assistantOrigin =
      context.assistantOrigin || record.role === "assistant";
    const currentIsToolResultEnvelope = isToolResultEnvelope(record);
    const toolResultEnvelope =
      context.toolResultEnvelope || currentIsToolResultEnvelope;
    const envelopeId =
      stringField(record.tool_use_id) ??
      stringField(record.tool_call_id) ??
      stringField(record.call_id) ??
      stringField(record.id) ??
      context.envelopeId;
    const nativeResultSite =
      context.nativeResultSite ||
      (toolResultEnvelope === true &&
        envelopeId !== undefined &&
        nativeResultCallIds.has(normalizeCallId(envelopeId) ?? envelopeId));
    const childNativeId =
      stringField(record["task-id"]) ??
      taskIdIn(record) ??
      context.childNativeId;
    const nested: WalkContext = {
      ...context,
      topLevel: false,
      assistantOrigin,
      toolResultEnvelope,
      nativeResultSite,
      ...(envelopeId ? { envelopeId } : {}),
      ...(childNativeId ? { childNativeId } : {}),
    };

    const status =
      nativeResultSite && !isToolResultEnvelope(record)
        ? asRecord(record.status)
        : undefined;
    const canonicalStatus = status
      ? canonicalizeStatus(status, nested, collected)
      : undefined;
    if (canonicalStatus) {
      for (const key of Object.keys(record)) delete record[key];
      record.status = canonicalStatus;
      return record;
    }

    for (const [key, entry] of Object.entries(record)) {
      if (
        key === "__proto__" ||
        key === "constructor" ||
        key === "prototype" ||
        (key === "status" && canonicalStatus)
      ) {
        continue;
      }
      record[key] = walk(entry, {
        ...nested,
        nativeResultSite:
          nativeResultSite &&
          (!currentIsToolResultEnvelope ||
            key === "content" ||
            key === "output"),
        // Responses API `output` holds assistant-authored history even though
        // its message objects do not always repeat a role.
        assistantOrigin:
          assistantOrigin || (context.topLevel === true && key === "output"),
      });
    }
    return value;
  };

  walk(body);
  return {
    receipts: collected.receipts,
    completions: collected.completions,
  };
}

/** Shows whether this deployment can issue receipts for crossed child returns. */
export function childReturnReceiptsConfigured(): boolean {
  return receiptKey() !== undefined;
}

// === Receipt parsing ===

type WalkContext = {
  childNativeId?: string;
  spawnCallId?: string;
  envelopeId?: string;
  assistantOrigin: boolean;
  toolResultEnvelope: boolean;
  nativeResultSite: boolean;
  topLevel?: boolean;
};

type ParsedReceiptValue = {
  value: string;
  receipt?: AppaChildReturnReceipt;
};

type NativeEnvelope = { open: string; close: string };

const DEFAULT_CONTEXT: WalkContext = {
  assistantOrigin: false,
  toolResultEnvelope: false,
  nativeResultSite: false,
  topLevel: true,
};
const TASK_NOTIFICATION: NativeEnvelope = {
  open: "<task-notification>",
  close: "</task-notification>",
};
const SUBAGENT_NOTIFICATION: NativeEnvelope = {
  open: "<subagent_notification>",
  close: "</subagent_notification>",
};
const MARK_TOP = "▄█▄▄▄█▄";
const MARK_BOTTOM = "██▄█▄██";
const PROOF_VERSION = 1;
const MACHINE_TOKEN_PREFIX = "appar-";
const MAX_CLAIMS_BYTES = 16 * 1024;
const MAX_PROOF_PAYLOAD_CHARS = 24 * 1024;
const RECEIPT_CODE = "[0-9A-HJKMNP-TV-Z]{3}-[0-9A-HJKMNP-TV-Z]{4}";
const RECEIPT_PHRASE =
  "(?:finished subagent|finished protected subagent|protected subagent session|protected subagent return|protected delegated return)";
const MACHINE_TOKEN = `${MACHINE_TOKEN_PREFIX}[A-Za-z0-9_-]{1,${MAX_PROOF_PAYLOAD_CHARS}}\\.[0-9a-f]{64}`;
// Inspects indentation only at line starts to keep text scanning linear.
const MARKER = new RegExp(
  `(?:^|(?<=\\n))[\\t ]*(?:${MARK_TOP}(?:\\r?\\n|[\\t ]{1,8})${MARK_BOTTOM}[\\t ]{1,8})?${RECEIPT_PHRASE}[\\t ]+(?:([A-Za-z0-9_:-]{1,512})[\\t ]+)?(${RECEIPT_CODE})(?![0-9A-HJKMNP-TV-Z])[\\t ]*\\r?\\n[\\t ]*\\[appa\\][\\t ]+child[\\t ]+return[\\t ]+(${MACHINE_TOKEN})\\.[\\t ]*(?=\\r?\\n|$)`,
  "gm",
);
const MAX_SCAN_BYTES = 8 * 1024 * 1024;

function stripReceipt(
  value: string,
  context: WalkContext,
  completionCarrier = false,
): ParsedReceiptValue {
  if (Buffer.byteLength(value, "utf8") > MAX_SCAN_BYTES) {
    if (!hasReceiptMarker(value)) return { value };
    throw new ApiError(400, "OpenAPPA child-return carrier exceeds its limit");
  }

  const pattern = new RegExp(MARKER.source, "g");
  const matches = [...value.matchAll(pattern)];
  if (matches.length === 0) {
    if (completionCarrier && hasReceiptMarker(value)) {
      throw new ApiError(
        400,
        "OpenAPPA received a malformed child-return receipt",
      );
    }
    return { value };
  }
  if (matches.length !== 1) {
    throw new ApiError(400, "OpenAPPA child-return carrier is ambiguous");
  }

  const match = matches[0];
  const displayCode = match[2];
  const token = match[3];
  if (!displayCode || !token) {
    throw new ApiError(
      400,
      "OpenAPPA received a malformed child-return receipt",
    );
  }
  const matchStart = match.index ?? 0;
  const markerStart = receiptSeparatorStart(value, matchStart);
  const markerEnd = matchStart + match[0].length;
  const stripped = `${value.slice(0, markerStart)}${value.slice(markerEnd)}`;
  return {
    value: stripped,
    receipt: {
      token,
      displayCode,
      value: stripped,
      childNativeId: match[1] ?? context.childNativeId,
      ...(context.spawnCallId ? { spawnCallId: context.spawnCallId } : {}),
      ...(context.envelopeId ? { envelopeId: context.envelopeId } : {}),
      assistantOrigin: context.assistantOrigin,
    },
  };
}

function replaceTaskNotifications(
  value: string,
  context: WalkContext,
  collected: CollectedChildReturns,
): string {
  const { open, close } = TASK_NOTIFICATION;
  let cursor = 0;
  const canonical: string[] = [];
  while (true) {
    const start = value.indexOf(open, cursor);
    if (start === -1) break;
    const end = value.indexOf(close, start + open.length);
    if (end === -1) {
      throw new ApiError(
        400,
        "OpenAPPA received a malformed task notification",
      );
    }
    const after = end + close.length;
    const block = value.slice(start, after);
    if (block.includes("<status>completed</status>")) {
      const resultOpen = "<result>";
      const resultClose = "</result>";
      const resultStart = block.indexOf(resultOpen);
      const resultEnd = block.indexOf(
        resultClose,
        resultStart + resultOpen.length,
      );
      const duplicate = block.indexOf(
        resultOpen,
        resultStart + resultOpen.length,
      );
      if (resultStart === -1 || resultEnd === -1 || duplicate !== -1) {
        throw new ApiError(
          400,
          "OpenAPPA received a malformed task notification",
        );
      }
      const taskId = tagValue(block, "task-id");
      const toolUseId = tagValue(block, "tool-use-id");
      if (
        !isBoundedNativeMetadata(taskId) ||
        (toolUseId !== undefined && !isBoundedNativeMetadata(toolUseId))
      ) {
        throw new ApiError(
          400,
          "OpenAPPA received invalid task notification metadata",
        );
      }
      const taskContext: WalkContext = {
        ...context,
        childNativeId: taskId,
        spawnCallId: toolUseId ?? context.spawnCallId,
        envelopeId: context.envelopeId ?? toolUseId,
      };
      const result = block.slice(resultStart + resultOpen.length, resultEnd);
      const parsed = stripReceipt(result, taskContext, true);
      recordCompletion(parsed, taskContext, collected);
      canonical.push(
        [
          open,
          `<task-id>${taskId}</task-id>`,
          ...(toolUseId ? [`<tool-use-id>${toolUseId}</tool-use-id>`] : []),
          "<status>completed</status>",
          `<result>${parsed.value}</result>`,
          close,
        ].join("\n"),
      );
    }
    cursor = after;
  }
  if (cursor === 0 || canonical.length === 0) return value;
  return canonical.join("\n");
}

function replaceTaskResults(
  value: string,
  context: WalkContext,
  collected: CollectedChildReturns,
): string {
  const open = "<task_result>";
  const close = "</task_result>";
  let cursor = 0;
  const canonical: string[] = [];
  while (true) {
    const start = value.indexOf(open, cursor);
    if (start === -1) break;
    const end = value.indexOf(close, start + open.length);
    if (end === -1) {
      throw new ApiError(400, "OpenAPPA received a malformed task result");
    }
    const taskId = taskElementId(value.slice(cursor, start));
    if (taskId !== undefined && !isBoundedNativeMetadata(taskId)) {
      throw new ApiError(400, "OpenAPPA received invalid task result metadata");
    }
    const taskContext: WalkContext = {
      ...context,
      childNativeId: taskId ?? context.childNativeId,
    };
    const result = value.slice(start + open.length, end);
    const parsed = stripReceipt(result, taskContext, true);
    recordCompletion(parsed, taskContext, collected);
    canonical.push(`${open}${parsed.value}${close}`);
    cursor = end + close.length;
  }
  if (cursor === 0) return value;
  return canonical.join("\n");
}

function replaceSubagentNotifications(
  value: string,
  context: WalkContext,
  collected: CollectedChildReturns,
): string {
  const { open, close } = SUBAGENT_NOTIFICATION;
  let cursor = 0;
  const canonical: string[] = [];
  while (true) {
    const start = value.indexOf(open, cursor);
    if (start === -1) break;
    const end = value.indexOf(close, start + open.length);
    if (end === -1) {
      throw new ApiError(
        400,
        "OpenAPPA received a malformed subagent notification",
      );
    }
    const inside = value.slice(start + open.length, end);
    const parsedJson = tryParseJson(inside.trim());
    const object = asRecord(parsedJson);
    const status = asRecord(object?.status);
    const completed = status ? stringField(status.completed) : undefined;
    if (object && status && completed !== undefined) {
      const agentPath = optionalBoundedMetadata(object.agent_path);
      const agentId = optionalBoundedMetadata(object.agent_id);
      const toolUseId = optionalBoundedMetadata(
        object.tool_use_id ?? object["tool-use-id"] ?? object.call_id,
      );
      if (
        hasInvalidMetadata(object.agent_path, agentPath) ||
        hasInvalidMetadata(object.agent_id, agentId) ||
        hasInvalidMetadata(
          object.tool_use_id ?? object["tool-use-id"] ?? object.call_id,
          toolUseId,
        )
      ) {
        throw new ApiError(
          400,
          "OpenAPPA received invalid subagent notification metadata",
        );
      }
      const childContext: WalkContext = {
        ...context,
        childNativeId: agentPath ?? agentId ?? context.childNativeId,
        spawnCallId: toolUseId ?? context.spawnCallId,
        envelopeId: context.envelopeId ?? toolUseId,
      };
      const parsed = stripReceipt(completed, childContext, true);
      recordCompletion(parsed, childContext, collected);
      const admitted: Record<string, unknown> = {};
      if (agentPath) admitted.agent_path = agentPath;
      else if (agentId) admitted.agent_id = agentId;
      if (toolUseId) admitted.tool_use_id = toolUseId;
      admitted.status = { completed: parsed.value };
      canonical.push(`${open}\n${JSON.stringify(admitted)}\n${close}`);
    } else if (hasReceiptMarker(inside)) {
      throw new ApiError(
        400,
        "OpenAPPA received a malformed subagent notification",
      );
    }
    cursor = end + close.length;
  }
  if (cursor === 0 || canonical.length === 0) return value;
  return canonical.join("\n");
}

function replaceAgentReport(
  value: string,
  context: WalkContext,
  collected: CollectedChildReturns,
): string {
  if (!hasReceiptMarker(value)) return value;
  const marker = value.includes("The report follows:\r\n")
    ? "The report follows:\r\n"
    : value.includes("The report follows:\n")
      ? "The report follows:\n"
      : undefined;
  if (!marker) return value;
  const markerAt = value.indexOf(marker);
  const contentAt = markerAt + marker.length;
  const agentMessageEnd = value.indexOf("</agent-message>", contentAt);
  const contentEnd = agentMessageEnd === -1 ? value.length : agentMessageEnd;
  const content = value.slice(contentAt, contentEnd);
  const lines = content.split("\n");
  const metadataAt = lines.findIndex(
    (line) =>
      /^\s*agentId:\s*[a-zA-Z0-9_:-]+/.test(line) || line.startsWith("<usage>"),
  );
  const reportLines = metadataAt === -1 ? lines : lines.slice(0, metadataAt);
  const report = reportLines
    .map((line) => (line.startsWith("  ") ? line.slice(2) : line))
    .join("\n");
  const childNativeId =
    agentMessageSender(value) ??
    value.match(/agentId:\s*([a-zA-Z0-9_:-]+)/)?.[1] ??
    context.childNativeId;
  if (childNativeId && !isBoundedNativeMetadata(childNativeId)) {
    throw new ApiError(400, "OpenAPPA received invalid agent report metadata");
  }
  const childContext: WalkContext = {
    ...context,
    ...(childNativeId ? { childNativeId } : {}),
  };
  const parsed = stripReceipt(report, childContext, true);
  recordCompletion(parsed, childContext, collected);
  return parsed.value;
}

function canonicalizeStatus(
  status: Record<string, unknown>,
  context: WalkContext,
  collected: CollectedChildReturns,
): Record<string, unknown> | undefined {
  if (typeof status.completed === "string") {
    const parsed = stripReceipt(status.completed, context, true);
    recordCompletion(parsed, context, collected);
    return { completed: parsed.value };
  }

  const canonical: Record<string, unknown> = {};
  for (const [childNativeId, entry] of Object.entries(status)) {
    const child = asRecord(entry);
    if (!child || typeof child.completed !== "string") continue;
    if (!isBoundedNativeMetadata(childNativeId)) {
      throw new ApiError(
        400,
        "OpenAPPA received invalid completed child metadata",
      );
    }
    const childContext = { ...context, childNativeId };
    const parsed = stripReceipt(child.completed, childContext, true);
    recordCompletion(parsed, childContext, collected);
    canonical[childNativeId] = { completed: parsed.value };
  }
  return Object.keys(canonical).length > 0 ? canonical : undefined;
}

function recordCompletion(
  parsed: ParsedReceiptValue,
  context: WalkContext,
  collected: CollectedChildReturns,
): void {
  if (parsed.receipt) collected.receipts.push(parsed.receipt);
  collected.completions.push({
    value: parsed.value,
    ...(context.childNativeId ? { childNativeId: context.childNativeId } : {}),
    ...(context.spawnCallId ? { spawnCallId: context.spawnCallId } : {}),
    ...(context.envelopeId ? { envelopeId: context.envelopeId } : {}),
    assistantOrigin: context.assistantOrigin,
    ...(parsed.receipt ? { receipt: parsed.receipt } : {}),
  });
}

function receiptSeparatorStart(value: string, matchStart: number): number {
  let start = matchStart;
  while (start > 0 && isHorizontalWhitespace(value[start - 1])) start -= 1;
  for (let count = 0; count < 2; count += 1) {
    if (start === 0 || value[start - 1] !== "\n") break;
    start -= 1;
    if (start > 0 && value[start - 1] === "\r") start -= 1;
  }
  return start;
}

function hasReceiptMarker(value: string): boolean {
  if (
    value.includes(MARK_TOP) ||
    value.includes(MARK_BOTTOM) ||
    value.includes(`[appa] child return ${MACHINE_TOKEN_PREFIX}`)
  ) {
    return true;
  }
  const intro = new RegExp(
    `(?:^|\\r?\\n)[\\t ]*${RECEIPT_PHRASE}(?:[\\t ]|$)`,
    "m",
  );
  return intro.test(value);
}

function isHorizontalWhitespace(value: string | undefined): boolean {
  return value === " " || value === "\t";
}

function jsonContainer(value: string): unknown | undefined {
  const first = value.trimStart()[0];
  return first === "{" || first === "[" ? tryParseJson(value) : undefined;
}

function normalizeCallId(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  return parseTrajectoryStamp(value)?.callId ?? value;
}

// === Stateless authentication ===

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const KEY_LABEL = "archestra.appa.child-return-proof.key.v1";
const PROOF_MAC_DOMAIN = "archestra.appa.child-return-proof.mac.v1";
const HEX_SHA256 = /^[0-9a-f]{64}$/;
const MACHINE_TOKEN_VALUE = new RegExp(
  `^${MACHINE_TOKEN_PREFIX}([A-Za-z0-9_-]{1,${MAX_PROOF_PAYLOAD_CHARS}})\\.([0-9a-f]{64})$`,
);
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

type ChildReturnClaims = [
  1,
  string,
  string | null,
  string,
  string,
  string | null,
  string | null,
  string,
];

function encodeClaims(claims: ChildReturnClaims): string {
  if (!isChildReturnClaims(claims)) {
    throw new ApiError(400, "OpenAPPA child-return claims are invalid");
  }
  const encoded = Buffer.from(JSON.stringify(claims), "utf8");
  if (encoded.length > MAX_CLAIMS_BYTES) {
    throw new ApiError(400, "OpenAPPA child-return claims exceed their limit");
  }
  return encoded.toString("base64url");
}

function verifyProof(params: {
  token: string;
  key: Buffer;
}): ChildReturnClaims | null {
  const match = params.token.match(MACHINE_TOKEN_VALUE);
  const payload = match?.[1];
  const actualMac = match?.[2];
  if (!payload || !actualMac) return null;
  const expectedMac = proofMac({ key: params.key, payload });
  if (!safeEqual(actualMac, expectedMac)) return null;

  let decoded: Buffer;
  let parsed: unknown;
  try {
    decoded = Buffer.from(payload, "base64url");
    if (
      decoded.length === 0 ||
      decoded.length > MAX_CLAIMS_BYTES ||
      decoded.toString("base64url") !== payload
    ) {
      return null;
    }
    parsed = JSON.parse(UTF8_DECODER.decode(decoded));
  } catch {
    return null;
  }
  if (!isChildReturnClaims(parsed)) return null;
  return encodeClaims(parsed) === payload ? parsed : null;
}

function proofMac(params: { key: Buffer; payload: string }): string {
  return createHmac("sha256", params.key)
    .update(PROOF_MAC_DOMAIN)
    .update("\0")
    .update(params.payload)
    .digest("hex");
}

function isChildReturnClaims(value: unknown): value is ChildReturnClaims {
  if (!Array.isArray(value) || value.length !== 8 || value[0] !== PROOF_VERSION)
    return false;
  return (
    isBoundedClaim(value[1]) &&
    (value[2] === null || isBoundedClaim(value[2])) &&
    isBoundedClaim(value[3]) &&
    isBoundedClaim(value[4]) &&
    (value[5] === null || isBoundedClaim(value[5])) &&
    (value[6] === null || isBoundedClaim(value[6])) &&
    typeof value[7] === "string" &&
    HEX_SHA256.test(value[7])
  );
}

function isBoundedClaim(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    Buffer.byteLength(value, "utf8") <= MAX_CLAIMS_BYTES
  );
}

function formatReceipt(params: {
  token: string;
  displayCode: string;
  format: "full" | "inline" | undefined;
}): string {
  const display =
    params.format === "inline"
      ? `finished subagent ${params.displayCode}`
      : `${MARK_TOP}\n${MARK_BOTTOM}  finished subagent ${params.displayCode}`;
  return `${display}\n[appa] child return ${params.token}.`;
}

function receiptKey(): Buffer | undefined {
  const secret = config.openappa.offerSigningSecret;
  return secret.length > 0
    ? createHmac("sha256", secret).update(KEY_LABEL).digest()
    : undefined;
}

function hashValue(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function safeEqual(actual: string, expected: string): boolean {
  const actualBytes = Buffer.from(actual, "utf8");
  const expectedBytes = Buffer.from(expected, "utf8");
  return (
    actualBytes.length === expectedBytes.length &&
    timingSafeEqual(actualBytes, expectedBytes)
  );
}

function first35Bits(digest: Buffer): bigint {
  let value = 0n;
  for (let index = 0; index < 5; index += 1) {
    value = (value << 8n) | BigInt(digest[index] ?? 0);
  }
  return value >> 5n;
}

function encodeCrockford35(value: bigint): string {
  let bits = value;
  const chars: string[] = [];
  for (let index = 0; index < 7; index += 1) {
    chars.push(CROCKFORD[Number(bits & 31n)] ?? "0");
    bits >>= 5n;
  }
  const code = chars.reverse().join("");
  return `${code.slice(0, 3)}-${code.slice(3)}`;
}

// === Shape helpers ===

const NATIVE_COMPLETION_TOOLS = new Set([
  "Agent",
  "Task",
  "task",
  "wait_agent",
]);
const NATIVE_METADATA = /^[A-Za-z0-9_.:@/-]{1,512}$/;

function collectNativeResultCallIds(body: unknown): Set<string> {
  const ids = new Set<string>();
  const root = asRecord(body);
  for (const message of Array.isArray(root?.messages) ? root.messages : []) {
    const record = asRecord(message);
    if (record?.role !== "assistant") continue;
    for (const call of Array.isArray(record.tool_calls)
      ? record.tool_calls
      : []) {
      const toolCall = asRecord(call);
      const fn = asRecord(toolCall?.function);
      addNativeResultCallId(
        ids,
        stringField(toolCall?.id),
        stringField(fn?.name) ?? stringField(toolCall?.name),
      );
    }
    for (const block of Array.isArray(record.content) ? record.content : []) {
      const toolUse = asRecord(block);
      if (toolUse?.type !== "tool_use") continue;
      addNativeResultCallId(
        ids,
        stringField(toolUse.id),
        stringField(toolUse.name),
      );
    }
  }
  for (const key of ["input", "output"] as const) {
    for (const item of Array.isArray(root?.[key]) ? root[key] : []) {
      const call = asRecord(item);
      if (call?.type !== "function_call" && call?.type !== "custom_tool_call") {
        continue;
      }
      addNativeResultCallId(
        ids,
        stringField(call.call_id) ?? stringField(call.id),
        stringField(call.name),
      );
    }
  }
  return ids;
}

function addNativeResultCallId(
  ids: Set<string>,
  callId: string | undefined,
  name: string | undefined,
): void {
  if (
    !callId ||
    !name ||
    !NATIVE_COMPLETION_TOOLS.has(localNativeToolName(name))
  )
    return;
  ids.add(normalizeCallId(callId) ?? callId);
}

function localNativeToolName(name: string): string {
  const withoutFunctions = name.startsWith("functions.")
    ? name.slice("functions.".length)
    : name;
  for (const prefix of [
    "host/claude-code/",
    "host/archestra/",
    "builtin:",
    "host/",
  ]) {
    if (withoutFunctions.startsWith(prefix)) {
      return withoutFunctions.slice(prefix.length);
    }
  }
  return withoutFunctions;
}

function isStandaloneEnvelope(
  value: string,
  envelope: NativeEnvelope,
): boolean {
  const trimmed = value.trim();
  return trimmed.startsWith(envelope.open) && trimmed.endsWith(envelope.close);
}

function startsWithEnvelope(value: string, envelope: NativeEnvelope): boolean {
  return value.trimStart().startsWith(envelope.open);
}

function isCompleteTaskResultFraming(value: string): boolean {
  const open = "<task_result>";
  const close = "</task_result>";
  const start = value.indexOf(open);
  const end = value.lastIndexOf(close);
  if (start === -1 || end < start) return false;
  const prefix = value.slice(0, start).trim();
  const suffix = value.slice(end + close.length).trim();
  const validPrefix = prefix === "" || /^<task\b[^>]*>$/.test(prefix);
  return validPrefix && (suffix === "" || suffix === "</task>");
}

function isBoundedNativeMetadata(value: unknown): value is string {
  return typeof value === "string" && NATIVE_METADATA.test(value);
}

function optionalBoundedMetadata(value: unknown): string | undefined {
  return isBoundedNativeMetadata(value) ? value : undefined;
}

function hasInvalidMetadata(
  original: unknown,
  bounded: string | undefined,
): boolean {
  return original !== undefined && original !== null && bounded === undefined;
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function taskIdIn(record: Record<string, unknown>): string | undefined {
  return stringField(record.task_id) ?? stringField(record.taskId);
}

function isToolResultEnvelope(record: Record<string, unknown>): boolean {
  return (
    record.role === "tool" ||
    record.type === "tool_result" ||
    record.type === "function_call_output" ||
    record.type === "custom_tool_call_output"
  );
}

function tagValue(value: string, tag: string): string | undefined {
  const open = `<${tag}>`;
  const close = `</${tag}>`;
  const start = value.indexOf(open);
  if (start === -1) return undefined;
  const end = value.indexOf(close, start + open.length);
  return end === -1 ? undefined : value.slice(start + open.length, end);
}

function taskElementId(value: string): string | undefined {
  const task = value.lastIndexOf("<task");
  if (task === -1) return undefined;
  const end = value.indexOf(">", task);
  if (end === -1) return undefined;
  return value.slice(task, end + 1).match(/\bid="([^"]+)"/)?.[1];
}

function agentMessageSender(value: string): string | undefined {
  const start = value.indexOf("<agent-message");
  if (start === -1) return undefined;
  const end = value.indexOf(">", start);
  if (end === -1) return undefined;
  return value.slice(start, end + 1).match(/\bfrom="([^"]+)"/)?.[1];
}

function tryParseJson(value: string): unknown | undefined {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}
