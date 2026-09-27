/**
 * Stateless child-trajectory carriers.
 *
 * The short started marker is display only. The adjacent `appact2` token
 * carries the signed binding so compaction preserves lineage without database state.
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import config from "@/config";
import { ApiError } from "@/types/api";

export type AppaChildTrajectoryReceipt = {
  token: string;
  organizationId: string;
  callerId?: string;
  parentId: string;
  childId: string;
  childNativeId?: string;
  spawnerNativeId: string;
  spawnCallId?: string;
};

const MARK_TOP = "▄█▄▄▄█▄";
const MARK_BOTTOM = "██▄█▄██";
const LOGO_PATTERN = String.raw`(?:${MARK_TOP}\n${MARK_BOTTOM}|${MARK_TOP}\s+${MARK_BOTTOM})`;
const DISPLAY_LABEL = "archestra.appa.child-trajectory-display.v1";
const PROOF_LABEL = "archestra.appa.child-trajectory.v2";
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const MAX_SCAN_BYTES = 8 * 1024 * 1024;
const MAX_CLAIMS_BYTES = 16 * 1024;
const MAX_RECEIPTS_PER_SITE = 64;
const PROOF_LINE_PREFIX = "[appa] child trajectory appact2-";
const TOKEN_SOURCE = String.raw`appact2-[A-Za-z0-9_-]+\.[0-9a-f]{64}`;
const TOKEN = /^(appact2-([A-Za-z0-9_-]+)\.([0-9a-f]{64}))$/;
const DISPLAY_MARKER = String.raw`(?:${LOGO_PATTERN}\s+)?(?:started subagent|started protected subagent|protected delegated session)(?:\s+[A-Za-z0-9_:-]+)?\s+[A-Za-z0-9_-]{1,64}`;
const CARRIER = new RegExp(
  String.raw`${DISPLAY_MARKER}\s*\n?\[appa\] child trajectory (?<token>${TOKEN_SOURCE})\.`,
  "g",
);

type ReceiptClaims = readonly [
  2,
  string,
  string | null,
  string,
  string,
  string | null,
  string,
  string | null,
];

export function mintChildTrajectoryReceipt(params: {
  organizationId: string;
  callerId: string | undefined;
  parentId: string;
  childId?: string;
  childNativeId?: string;
  spawnerNativeId: string;
  spawnCallId?: string;
  format?: "full" | "inline";
}): string | undefined {
  const { childId, childNativeId } = params;
  if (
    !nonEmptyString(params.organizationId) ||
    !nonEmptyString(params.parentId) ||
    !nonEmptyString(childId) ||
    !nonEmptyString(params.spawnerNativeId) ||
    (childNativeId !== undefined && !nonEmptyString(childNativeId)) ||
    (params.callerId !== undefined && !nonEmptyString(params.callerId)) ||
    (params.spawnCallId !== undefined && !nonEmptyString(params.spawnCallId))
  ) {
    return undefined;
  }
  const key = receiptKey();
  if (!key) return undefined;
  const claims: ReceiptClaims = [
    2,
    params.organizationId,
    params.callerId ?? null,
    params.parentId,
    childId,
    childNativeId ?? null,
    params.spawnerNativeId,
    params.spawnCallId ?? null,
  ];
  const canonicalClaims = JSON.stringify(claims);
  if (Buffer.byteLength(canonicalClaims, "utf8") > MAX_CLAIMS_BYTES) {
    return undefined;
  }
  const payload = Buffer.from(canonicalClaims, "utf8").toString("base64url");
  const token = `appact2-${payload}.${receiptTag(key, payload)}`;
  const code = mintDisplayCode(params);
  const display =
    params.format === "inline"
      ? `started subagent ${code}`
      : `${MARK_TOP}\n${MARK_BOTTOM}  started subagent ${code}`;
  return `${display}\n[appa] child trajectory ${token}.`;
}

export function verifyChildTrajectoryReceipt(params: {
  receipt: AppaChildTrajectoryReceipt;
  organizationId: string;
  callerId: string | undefined;
  spawnerNativeId: string;
  childNativeId?: string;
}): boolean {
  const key = receiptKey();
  if (!key) return false;
  const parsed = parseToken(params.receipt.token);
  if (!parsed || !sameReceipt(parsed.receipt, params.receipt)) return false;
  if (
    parsed.receipt.organizationId !== params.organizationId ||
    parsed.receipt.callerId !== params.callerId ||
    parsed.receipt.spawnerNativeId !== params.spawnerNativeId ||
    (parsed.receipt.childNativeId !== undefined &&
      params.childNativeId !== undefined &&
      parsed.receipt.childNativeId !== params.childNativeId)
  ) {
    return false;
  }
  const actual = Buffer.from(parsed.tag, "hex");
  const expected = Buffer.from(receiptTag(key, parsed.payload), "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function appendChildTrajectoryReceipt(
  text: string,
  footer: string,
): string {
  return `${footer}\n\n${text}`;
}

export function stripChildTrajectoryReceipts(text: string): {
  text: string;
  receipts: AppaChildTrajectoryReceipt[];
} {
  if (Buffer.byteLength(text, "utf8") > MAX_SCAN_BYTES) {
    if (!text.includes(PROOF_LINE_PREFIX)) return { text, receipts: [] };
    throw new ApiError(
      400,
      "OpenAPPA child-trajectory carrier exceeds its limit",
    );
  }
  const receipts: AppaChildTrajectoryReceipt[] = [];
  let stripped = text;
  const matches = [...text.matchAll(clonePattern())];
  if (matches.length === 0) return { text, receipts };
  if (matches.length > MAX_RECEIPTS_PER_SITE) {
    throw new ApiError(
      400,
      "OpenAPPA received too many child-trajectory carriers",
    );
  }
  for (let index = matches.length - 1; index >= 0; index--) {
    const match = matches[index];
    const token = match.groups?.token;
    const parsed = token ? parseToken(token) : undefined;
    if (parsed) receipts.unshift(parsed.receipt);
    const start = match.index ?? 0;
    const end = start + match[0].length;
    const lead = adjacentNewlines(stripped, start, -1);
    const trail = adjacentNewlines(stripped, end, 1);
    stripped = `${stripped.slice(0, start - lead)}${stripped.slice(end + trail)}`;
  }
  return { text: stripped, receipts };
}

function parseToken(token: string):
  | {
      receipt: AppaChildTrajectoryReceipt;
      payload: string;
      tag: string;
    }
  | undefined {
  const match = TOKEN.exec(token);
  if (!match) return undefined;
  const [, canonicalToken, payload, tag] = match;
  if (!canonicalToken || !payload || !tag) return undefined;
  try {
    const decoded = Buffer.from(payload, "base64url");
    if (
      decoded.byteLength > MAX_CLAIMS_BYTES ||
      decoded.toString("base64url") !== payload
    ) {
      return undefined;
    }
    const claims: unknown = JSON.parse(decoded.toString("utf8"));
    if (!isReceiptClaims(claims)) return undefined;
    const [
      ,
      organizationId,
      callerId,
      parentId,
      childId,
      childNativeId,
      spawnerNativeId,
      spawnCallId,
    ] = claims;
    return {
      receipt: {
        token: canonicalToken,
        organizationId,
        ...(callerId === null ? {} : { callerId }),
        parentId,
        childId,
        ...(childNativeId === null ? {} : { childNativeId }),
        spawnerNativeId,
        ...(spawnCallId === null ? {} : { spawnCallId }),
      },
      payload,
      tag,
    };
  } catch {
    return undefined;
  }
}

function isReceiptClaims(value: unknown): value is ReceiptClaims {
  if (!Array.isArray(value) || value.length !== 8 || value[0] !== 2) {
    return false;
  }
  const [
    ,
    organizationId,
    callerId,
    parentId,
    childId,
    childNativeId,
    spawnerNativeId,
    spawnCallId,
  ] = value;
  return (
    nonEmptyString(organizationId) &&
    (callerId === null || nonEmptyString(callerId)) &&
    nonEmptyString(parentId) &&
    nonEmptyString(childId) &&
    (childNativeId === null || nonEmptyString(childNativeId)) &&
    nonEmptyString(spawnerNativeId) &&
    (spawnCallId === null || nonEmptyString(spawnCallId))
  );
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function sameReceipt(
  left: AppaChildTrajectoryReceipt,
  right: AppaChildTrajectoryReceipt,
): boolean {
  return (
    left.token === right.token &&
    left.organizationId === right.organizationId &&
    left.callerId === right.callerId &&
    left.parentId === right.parentId &&
    left.childId === right.childId &&
    left.childNativeId === right.childNativeId &&
    left.spawnerNativeId === right.spawnerNativeId &&
    left.spawnCallId === right.spawnCallId
  );
}

function receiptKey(): Buffer | undefined {
  const secret = config.openappa.offerSigningSecret;
  if (secret.length === 0) return undefined;
  return createHmac("sha256", secret).update(PROOF_LABEL).digest();
}

function receiptTag(key: Buffer, payload: string): string {
  return createHmac("sha256", key)
    .update(`${PROOF_LABEL}\n${payload}`)
    .digest("hex");
}

function mintDisplayCode(params: {
  organizationId: string;
  callerId: string | undefined;
  parentId: string;
  childId?: string;
  childNativeId?: string;
  spawnerNativeId: string;
  spawnCallId?: string;
}): string {
  const digest = createHash("sha256")
    .update(
      [
        DISPLAY_LABEL,
        params.organizationId,
        params.callerId ?? "",
        params.parentId,
        params.childId ?? "",
        params.childNativeId ?? "",
        params.spawnerNativeId,
        params.spawnCallId ?? "",
      ].join("\n"),
    )
    .digest();
  return encodeCrockford35(first35Bits(digest));
}

function clonePattern(): RegExp {
  return new RegExp(CARRIER.source, "g");
}

function first35Bits(digest: Buffer): bigint {
  let value = 0n;
  for (let index = 0; index < 5; index++) {
    value = (value << 8n) | BigInt(digest[index] ?? 0);
  }
  return value >> 5n;
}

function encodeCrockford35(value: bigint): string {
  let bits = value;
  const chars: string[] = [];
  for (let index = 0; index < 7; index++) {
    chars.push(CROCKFORD[Number(bits & 31n)] ?? "0");
    bits >>= 5n;
  }
  const code = chars.reverse().join("");
  return `${code.slice(0, 3)}-${code.slice(3)}`;
}

function adjacentNewlines(
  text: string,
  index: number,
  direction: -1 | 1,
): number {
  let at = index;
  for (let count = 0; count < 2; count++) {
    if (direction < 0 && text[at - 1] === "\n") {
      at -= text[at - 2] === "\r" ? 2 : 1;
    } else if (direction > 0 && text[at] === "\r" && text[at + 1] === "\n") {
      at += 2;
    } else if (direction > 0 && text[at] === "\n") {
      at++;
    } else break;
  }
  return Math.abs(at - index);
}
