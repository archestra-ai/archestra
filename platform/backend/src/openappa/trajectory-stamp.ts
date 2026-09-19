import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * A trajectory stamp is the tool-call id the proxy gives a client in place of
 * the provider's own: it carries that id and the session whose turn made the
 * call, signed for the organization and caller the session is scoped to.
 *
 * Clients send a call's id back verbatim wherever its history goes: the same
 * session, a fork, or a summarizer that compacts the context in a session of
 * its own and hands the summary back. A request whose history carries a stamp
 * therefore names the session that context came from, even under a new
 * session id, and the proxy opens that new session as a fork of it rather
 * than as a clean root for context that is not clean (see `lineage.ts`). The
 * proxy puts the provider's ids back before anything reads the history, so
 * the provider and the model only ever see their own.
 *
 * Layout: `appat1`, then base64url(`<session id>\0<provider call id>`), then a
 * 22-character base64url HMAC-SHA256 tag (128 bits). Every character is one a
 * provider accepts in a call id (`[A-Za-z0-9_-]`), so a client that sanitizes
 * ids for its provider leaves a stamp intact. One that also shortens them does
 * not, so a model whose ids a client cuts short is given no stamps at all.
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

/** The stamp an id is, or undefined for any other id. Parsing verifies nothing. */
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
 * The sessions this caller's verified stamps name, each once, ordered by where
 * its calls last appear in the history: the last one made the history's most
 * recent calls. Stamps signed for another caller or organization, or under
 * another secret, name nothing: that context was not this caller's to carry.
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
