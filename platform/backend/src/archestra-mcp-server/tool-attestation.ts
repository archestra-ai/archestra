import { createHmac, timingSafeEqual } from "node:crypto";
import config from "@/config";
import { isUuid } from "@/utils/uuid";

/**
 * Gateway tool attestation: proof, carried in a tool's own description, that
 * this platform's MCP gateway served the tool under a given name.
 *
 * The gateway puts an opaque marker, `[[gwa1.<payload>.<mac>]]`, in front of
 * every description it serves in tools/list. The description is the only
 * field that Claude Code 2.1.x, Codex 0.154 and OpenCode 1.18 all forward
 * verbatim: names are relabeled per client (`mcp__<label>__`, `<label>_`, a
 * Codex namespace), schemas lose unknown keywords, and title, annotations and
 * _meta never leave the client. The LLM proxy reads the marker back, verifies
 * it and strips it. It carries no brand string, because a client that talks
 * to the gateway without the proxy shows it to its model and in its UI as-is,
 * and a white-labeled deployment must not leak a product name there.
 *
 * payload = key version (1) ‖ gateway agent UUID (16 bytes) ‖ kind ‖ UTF-8
 * advertised name. Kind "b" is a platform built-in by catalog provenance, "t"
 * anything else. mac = the first 16 bytes of HMAC-SHA256(K_org, "gwa1\0" ‖
 * payload), with K_org = HMAC-SHA256(HMAC-SHA256(auth secret, KEY_DOMAIN),
 * organizationId): derived from the session-signing secret so no new
 * configuration is needed (as the Google Drive OAuth state does),
 * domain-separated from every other HMAC that secret protects, and bound to
 * the organization. Without an auth secret nothing is minted and nothing
 * verifies.
 *
 * Residual: a marker carries no epoch and no user. One that leaks from a
 * client session that bypasses the proxy therefore stays valid org-wide until
 * the auth secret rotates. A hostile server that replays it next to the real
 * gateway is demoted by the proxy's conflict rule (same gateway and name under
 * two spellings); with the real gateway absent, the replay is accepted.
 */

export type ToolAttestationKind = "b" | "t";

export type ToolAttestation = {
  /** Lowercase UUID of the gateway agent that served the tool. */
  gatewayId: string;
  kind: ToolAttestationKind;
  /** The exact name the gateway advertised in tools/list. */
  advertisedName: string;
};

/**
 * Removes every marker-shaped token from `description` (upstream forgeries
 * included), then puts a fresh marker in front. Mints nothing when
 * attestation is off (no auth secret), when `gatewayId` is not a UUID, or when
 * `advertisedName` is empty or longer than 512 UTF-8 bytes; the result is then
 * `description` without tokens, and stays `undefined` for an undefined one.
 */
export function attestToolDescription(params: {
  organizationId: string;
  gatewayId: string;
  advertisedName: string;
  kind: ToolAttestationKind;
  description: string | undefined;
}): string | undefined {
  const rest =
    params.description === undefined
      ? undefined
      : removeAttestationTokens(params.description);
  const key = organizationKey(params.organizationId);
  const payload = encodePayload(params);
  if (!key || !payload) return rest;
  const marker = `[[${TOKEN_TAG}.${payload.toString("base64url")}.${macOf(key, payload).toString("base64url")}]]`;
  return rest ? `${marker}\n${rest}` : marker;
}

/** Takes exactly one marker at index 0, plus a single following "\n" if present. */
export function takeLeadingAttestation(description: string): {
  marker?: string;
  rest: string;
} {
  const match = LEADING_TOKEN.exec(description);
  if (!match) return { rest: description };
  const taken = match[0];
  return {
    marker: taken.endsWith("\n") ? taken.slice(0, -1) : taken,
    rest: description.slice(taken.length),
  };
}

/**
 * Returns null on any failure: attestation off, malformed token, wrong MAC,
 * key version other than 1, bad kind byte, invalid UTF-8 or an empty name.
 */
export function verifyToolAttestation(params: {
  organizationId: string;
  marker: string;
}): ToolAttestation | null {
  const key = organizationKey(params.organizationId);
  const match = FULL_TOKEN.exec(params.marker);
  if (!key || !match) return null;
  const payload = decodeBase64Url(match[1]);
  const mac = decodeBase64Url(match[2]);
  if (
    !payload ||
    !mac ||
    mac.length !== MAC_BYTES ||
    payload.length < MIN_PAYLOAD_BYTES
  ) {
    return null;
  }
  if (!timingSafeEqual(mac, macOf(key, payload))) return null;
  return decodePayload(payload);
}

/**
 * Removes every token, each with one trailing "\n", and defangs every
 * "[[gwa1." left over, so no marker-shaped token survives. Linear in the
 * length of `text`. Returns the same string when "[[gwa1." is absent.
 */
export function removeAttestationTokens(text: string): string {
  if (!text.includes(TOKEN_OPENING)) return text;
  // Removing a token can splice its neighbors into a new one, and nested
  // tokens peel one layer per pass, so repeating the removal until stable is
  // quadratic on hostile input. One pass, then break every opening still
  // there: the replacement holds no ".", so it cannot form a new opening.
  return text
    .replace(ANY_TOKEN, "")
    .split(TOKEN_OPENING)
    .join(DEFANGED_OPENING);
}

/**
 * Cheap pre-check on raw bytes: false means they cannot hold a token, even
 * inside a JSON string that escapes its brackets.
 */
export function mayHoldAttestationToken(bytes: Buffer): boolean {
  return bytes.includes(TOKEN_TAG);
}

// === Internal helpers ===

const TOKEN_TAG = "gwa1";
const TOKEN_OPENING = `[[${TOKEN_TAG}.`;
const DEFANGED_OPENING = `[[${TOKEN_TAG}_`;
const KEY_DOMAIN = "archestra/gateway-tool-attestation/v1";
const KEY_VERSION = 1;
const MAC_BYTES = 16;
const MAX_NAME_BYTES = 512;
// Version byte, gateway UUID, kind byte and at least one name byte.
const MIN_PAYLOAD_BYTES = 1 + 16 + 1 + 1;

const FULL_TOKEN =
  /^\[\[gwa1\.([A-Za-z0-9_-]{1,720})\.([A-Za-z0-9_-]{22})\]\]$/;
const LEADING_TOKEN =
  /^\[\[gwa1\.([A-Za-z0-9_-]{1,720})\.([A-Za-z0-9_-]{22})\]\](?:\n|$)/;
const ANY_TOKEN = /\[\[gwa1\.[A-Za-z0-9_-]{1,720}\.[A-Za-z0-9_-]{22}\]\]\n?/g;

/** Read on every call, never cached: rotating or unsetting the secret takes effect at once. */
function organizationKey(organizationId: string): Buffer | null {
  const secret = config.auth.secret;
  if (!secret) return null;
  const root = createHmac("sha256", secret).update(KEY_DOMAIN).digest();
  return createHmac("sha256", root).update(organizationId).digest();
}

function macOf(key: Buffer, payload: Buffer): Buffer {
  return createHmac("sha256", key)
    .update(`${TOKEN_TAG}\0`)
    .update(payload)
    .digest()
    .subarray(0, MAC_BYTES);
}

function encodePayload(params: {
  gatewayId: string;
  kind: ToolAttestationKind;
  advertisedName: string;
}): Buffer | null {
  if (!isUuid(params.gatewayId)) return null;
  const name = Buffer.from(params.advertisedName, "utf8");
  // A name that does not survive UTF-8 (a lone surrogate) would verify as a
  // different name than the one served.
  if (
    name.length === 0 ||
    name.length > MAX_NAME_BYTES ||
    name.toString("utf8") !== params.advertisedName
  ) {
    return null;
  }
  return Buffer.concat([
    Buffer.from([KEY_VERSION]),
    Buffer.from(params.gatewayId.replace(/-/g, ""), "hex"),
    Buffer.from(params.kind, "ascii"),
    name,
  ]);
}

function decodePayload(payload: Buffer): ToolAttestation | null {
  if (payload[0] !== KEY_VERSION) return null;
  const kind = String.fromCharCode(payload[17]);
  if (kind !== "b" && kind !== "t") return null;
  const nameBytes = payload.subarray(18);
  if (nameBytes.length > MAX_NAME_BYTES) return null;
  let advertisedName: string;
  try {
    // ignoreBOM keeps a leading U+FEFF, so the name round-trips exactly.
    advertisedName = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: true,
    }).decode(nameBytes);
  } catch {
    return null;
  }
  if (!advertisedName) return null;
  const hex = payload.subarray(1, 17).toString("hex");
  return {
    gatewayId: `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`,
    kind,
    advertisedName,
  };
}

/**
 * Canonical base64url only. Node ignores the unused low bits of the last
 * character, so without this check several spellings of one marker verify.
 */
function decodeBase64Url(text: string): Buffer | null {
  const bytes = Buffer.from(text, "base64url");
  return bytes.toString("base64url") === text ? bytes : null;
}
