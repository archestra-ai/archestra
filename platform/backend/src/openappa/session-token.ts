import { createHmac } from "node:crypto";

const MARK_TOP = "▄█▄▄▄█▄";
const MARK_BOTTOM = "██▄█▄██";

const SESSION_RECEIPT_PATTERN =
  /▄█▄▄▄█▄ {2}protected session ([0-9A-HJKMNP-TV-Z]{3}-[0-9A-HJKMNP-TV-Z]{4})\n██▄█▄██/g;

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
  return `\n\n${MARK_TOP}  protected session ${code}\n${MARK_BOTTOM}`;
}

export function appendSessionReceipt(text: string, code: string): string {
  return `${text}${formatSessionReceipt(code)}`;
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
    const code = match[1];
    if (code) codes.unshift(code);
    const start = match.index ?? 0;
    const end = start + match[0].length;
    const lead = leadingNewlines(stripped, start);
    stripped = `${stripped.slice(0, start - lead)}${stripped.slice(end)}`;
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

function leadingNewlines(text: string, index: number): number {
  let count = 0;
  for (let offset = 1; offset <= 2; offset++) {
    if (text[index - offset] !== "\n") break;
    count += 1;
  }
  return count;
}
