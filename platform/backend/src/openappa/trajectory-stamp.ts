import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * A trajectory stamp replaces the provider's tool-call ID with a signed ID.
 * It encodes the provider call ID and source session, signed for the organization
 * and caller.
 *
 * Clients return this ID in conversation history across resumes, forks, and
 * compactions. The proxy reads the stamp to determine provenance and opens
 * new sessions as forks of the source session (see `lineage.ts`). The proxy
 * restores original provider IDs before policy evaluation and provider dispatch.
 *
 * Layout: `appat1`, base64url(`<session id>\0<provider call id>`), and a
 * 22-character base64url HMAC-SHA256 tag (128 bits). Characters match provider
 * allowances (`[A-Za-z0-9_-]`). Models that truncate IDs receive no stamps.
 */
export type TrajectoryStamp = {
  /** The client's own id of the session that made the call, unscoped. */
  sessionId: string;
  /** The provider's id for the call. */
  callId: string;
  payload: string;
  tag: string;
};

export function stampToolCallId(params: {
  callId: string;
  sessionId: string;
  organizationId: string;
  callerId: string;
  secret: string;
}): string {
  const payload = Buffer.from(
    `${params.sessionId}\u0000${params.callId}`,
    "utf8",
  ).toString("base64url");
  return `${STAMP_PREFIX}${payload}${stampTag({ ...params, payload })}`;
}

/** Parses a tool-call ID into a trajectory stamp. Returns undefined if not a stamp. */
export function parseTrajectoryStamp(id: string): TrajectoryStamp | undefined {
  if (
    !id.startsWith(STAMP_PREFIX) ||
    id.length <= STAMP_PREFIX.length + TAG_LENGTH
  )
    return undefined;
  const payload = id.slice(STAMP_PREFIX.length, -TAG_LENGTH);
  const tag = id.slice(-TAG_LENGTH);
  if (!BASE64URL.test(payload) || !BASE64URL.test(tag)) return undefined;
  const decoded = Buffer.from(payload, "base64url").toString("utf8");
  // One encoding per payload: a lenient decode would let two spellings of an
  // id stand for the same stamp.
  if (Buffer.from(decoded, "utf8").toString("base64url") !== payload)
    return undefined;
  const separator = decoded.indexOf("\u0000");
  if (separator <= 0 || separator === decoded.length - 1) return undefined;
  return {
    sessionId: decoded.slice(0, separator),
    callId: decoded.slice(separator + 1),
    payload,
    tag,
  };
}

/**
 * Returns unique verified session IDs from the supplied stamps, ordered from oldest
 * to most recent call.
 * Stamps signed for another caller, organization, or secret return nothing.
 */
export function stampedSessions(params: {
  stamps: readonly TrajectoryStamp[];
  organizationId: string;
  callerId: string;
  secret: string;
}): string[] {
  if (params.secret.length === 0) return [];
  const sessions = new Set<string>();
  const verifiedPayloads = new Set<string>();
  // A call and its result carry the same stamp. Walk back from the newest
  // history item so each payload is verified once while preserving last use.
  for (let index = params.stamps.length - 1; index >= 0; index--) {
    const stamp = params.stamps[index];
    if (verifiedPayloads.has(stamp.payload)) continue;
    verifiedPayloads.add(stamp.payload);
    const expected = Buffer.from(
      stampTag({ ...params, payload: stamp.payload }),
      "utf8",
    );
    const actual = Buffer.from(stamp.tag, "utf8");
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
      continue;
    sessions.add(stamp.sessionId);
  }
  return [...sessions].reverse();
}

// === Internal helpers ===

const STAMP_PREFIX = "appat1";
const TAG_LENGTH = 22;
const TAG_DOMAIN = "openappa-trajectory-stamp-v1";
const BASE64URL = /^[A-Za-z0-9_-]+$/;

function stampTag(params: {
  payload: string;
  organizationId: string;
  callerId: string;
  secret: string;
}): string {
  // 16 bytes of the MAC: 22 base64url characters, no padding.
  return createHmac("sha256", params.secret)
    .update(
      `${TAG_DOMAIN}\n${params.organizationId}\n${params.callerId}\n${params.payload}`,
    )
    .digest()
    .subarray(0, 16)
    .toString("base64url");
}
