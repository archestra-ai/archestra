import { createHmac, timingSafeEqual } from "node:crypto";
import { LRUCacheManager } from "@/cache-manager";
import config from "@/config";

const TTL_MS = 60 * 60 * 1000;
const MAX_ENTRIES = 1_000;
const MAX_RETAINED_BYTES = 1024 * 1024;

/**
 * Stores initialize-time client capabilities in memory for stateless MCP requests.
 * Modern clients include capabilities in `_meta` on each request.
 * Legacy clients declare capabilities once at initialize.
 * This store retains capabilities by profile, token, and user agent so later
 * `tools/call` requests know whether the client supports server-initiated requests.
 *
 * In-memory storage matches in-process routing for in-band elicitation responses.
 */
class ClientCapabilityStore {
  private readonly entries = new LRUCacheManager<unknown>({
    maxSize: MAX_ENTRIES,
    defaultTtl: TTL_MS,
    maxBytes: MAX_RETAINED_BYTES,
    sizeOf: capabilitySize,
  });

  remember(params: { key: string; capabilities: unknown }): void {
    this.entries.set(params.key, params.capabilities);
  }

  lookup(params: { key: string }): unknown {
    return this.entries.get(params.key);
  }
}

export const clientCapabilityStore = new ClientCapabilityStore();

export function clientCapabilityKey(params: {
  profileId: string;
  tokenId?: string;
  userId?: string;
  userAgent?: string;
}): string {
  const { profileId, tokenId, userId, userAgent } = params;
  // One personal token commonly serves several clients at once, and each
  // declares its own capabilities: the client software is part of the key,
  // so a client without elicitation cannot overwrite one that has it.
  return `${profileId}:${tokenId ?? userId ?? "anonymous"}:${userAgent ?? ""}`;
}

/**
 * Encodes initialize-time capabilities into a signed `Mcp-Session-Id` header.
 *
 * The gateway maintains no session state behind the ID. The ID is a signed
 * payload bound to this gateway and caller, allowing it to survive restarts
 * and reach other replicas. The bearer token still authenticates every request.
 * Invalid session IDs are ignored.
 */
export function encodeCapabilitySession(params: {
  profileId: string;
  principal: string;
  capabilities: unknown;
  now?: number;
}): string | undefined {
  const { profileId, principal, capabilities, now = Date.now() } = params;
  const key = capabilitySessionKey();
  if (!key) return undefined;
  const payload: CapabilitySessionPayload = {
    v: CAPABILITY_SESSION_VERSION,
    p: profileId,
    u: principal,
    c: capabilities,
    exp: now + CAPABILITY_SESSION_TTL_MS,
  };
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  if (
    Buffer.byteLength(encoded) + 1 + CAPABILITY_SESSION_SIGNATURE_LENGTH >
    MAX_CAPABILITY_SESSION_ID_BYTES
  ) {
    return undefined;
  }
  return `${encoded}.${signCapabilitySession(key, encoded)}`;
}

/** The capabilities a session id records, when it is genuine and this caller's. */
export function readCapabilitySession(params: {
  sessionId: string | undefined;
  profileId: string;
  principal: string;
  now?: number;
}): unknown {
  const { sessionId, profileId, principal, now = Date.now() } = params;
  const key = capabilitySessionKey();
  if (!key || !sessionId) return undefined;
  const separator = sessionId.lastIndexOf(".");
  if (separator <= 0) return undefined;
  const encoded = sessionId.slice(0, separator);
  const expected = Buffer.from(signCapabilitySession(key, encoded));
  const presented = Buffer.from(sessionId.slice(separator + 1));
  if (
    expected.length !== presented.length ||
    !timingSafeEqual(expected, presented)
  ) {
    return undefined;
  }
  let payload: CapabilitySessionPayload;
  try {
    payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    return undefined;
  }
  if (
    payload?.v !== CAPABILITY_SESSION_VERSION ||
    payload.p !== profileId ||
    payload.u !== principal ||
    typeof payload.exp !== "number" ||
    payload.exp <= now
  ) {
    return undefined;
  }
  return payload.c;
}

type CapabilitySessionPayload = {
  v: number;
  /** The gateway the client initialized against. */
  p: string;
  /** The caller, as MRTR request state names it. */
  u: string;
  /** The capabilities the client declared at initialize. */
  c: unknown;
  exp: number;
};

const CAPABILITY_SESSION_VERSION = 1;
const CAPABILITY_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const CAPABILITY_SESSION_DOMAIN = "archestra.mcp-gateway.capability-session.v1";
// Keep the complete value well below common 8 KiB HTTP header limits.
const MAX_CAPABILITY_SESSION_ID_BYTES = 4 * 1024;
// SHA-256 is 32 bytes, which is 43 unpadded base64url characters.
const CAPABILITY_SESSION_SIGNATURE_LENGTH = 43;

/** Derived from the auth secret, domain-separated like MRTR request state. */
function capabilitySessionKey(): Buffer | null {
  const secret = config.auth.secret;
  if (!secret) return null;
  return createHmac("sha256", secret)
    .update(CAPABILITY_SESSION_DOMAIN)
    .digest();
}

function signCapabilitySession(key: Buffer, encoded: string): string {
  return createHmac("sha256", key).update(encoded).digest("base64url");
}

function capabilitySize(capabilities: unknown): number {
  try {
    const serialized = JSON.stringify(capabilities);
    return serialized === undefined
      ? Number.MAX_SAFE_INTEGER
      : Buffer.byteLength(serialized);
  } catch {
    // A request body is JSON, but do not retain an unexpected non-serializable
    // value if this store is ever called from another boundary.
    return Number.MAX_SAFE_INTEGER;
  }
}
