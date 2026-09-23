import { createHmac } from "node:crypto";

const MARK_TOP = "▄█▄▄▄█▄";
const MARK_BOTTOM = "██▄█▄██";
const RECEIPT_CODE = "([0-9A-HJKMNP-TV-Z]{3}-[0-9A-HJKMNP-TV-Z]{4})";

const SESSION_RECEIPT_PATTERN = new RegExp(
  `${MARK_TOP}\\r?\\n${MARK_BOTTOM} {2}(?:started )?protected session ${RECEIPT_CODE}|${MARK_TOP} {2}(?:started )?protected session ${RECEIPT_CODE}\\r?\\n${MARK_BOTTOM}`,
  "g",
);

export function mintReceiptCode(params: {
  secret: string;
  organizationId: string;
  callerId: string;
  sessionId: string;
  collision?: number;
}): string {
  const collision = params.collision ?? 0;
  const base = `${DOMAIN}\n${params.organizationId}\n${params.callerId}\n${params.sessionId}`;
  const input = collision > 0 ? `${base}\n${collision}` : base;
  const digest = createHmac("sha256", params.secret).update(input).digest();
  return encodeCrockford35(first35Bits(digest));
}

export function formatSessionReceipt(code: string): string {
  return `${MARK_TOP}\n${MARK_BOTTOM}  protected session ${code}`;
}

export function appendSessionReceipt(text: string, code: string): string {
  return `${formatSessionReceipt(code)}\n\n${text}`;
}

export function stripSessionReceipts(text: string): {
  text: string;
  codes: string[];
} {
  if (Buffer.byteLength(text, "utf8") > MAX_SCAN_BYTES) {
    return { text, codes: [] };
  }
  const codes: string[] = [];
  let stripped = text;
  const pattern = clonePattern();
  const matches = [...text.matchAll(pattern)].slice(0, MAX_CODES_PER_SITE);
  if (matches.length === 0) return { text, codes };
  for (let index = matches.length - 1; index >= 0; index--) {
    const match = matches[index];
    const code = match[1] ?? match[2];
    if (code) codes.unshift(code);
    const start = match.index ?? 0;
    const end = start + match[0].length;
    const lead = adjacentNewlines(stripped, start, -1);
    const trail = adjacentNewlines(stripped, end, 1);
    stripped = `${stripped.slice(0, start - lead)}${stripped.slice(end + trail)}`;
  }
  return { text: stripped, codes };
}

// === Internal helpers ===

const DOMAIN = "appa-session-receipt-v1";
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const MAX_SCAN_BYTES = 8 * 1024 * 1024;
const MAX_CODES_PER_SITE = 64;

function clonePattern(): RegExp {
  return new RegExp(SESSION_RECEIPT_PATTERN.source, "g");
}

// Receipt codes carry 35 bits (~34 billion values): birthday collisions become
// probable around ~250K active sessions per organization, so minting retries
// with a shifted HMAC input (`collision`) and degrades to issuing no mark.
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
