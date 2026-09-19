import { createHmac, timingSafeEqual } from "node:crypto";
import { ApiError } from "@/types";

/**
 * A trajectory stamp is the tool-call id the proxy gives a client in place of
 * the provider's own: it carries that id and the session whose turn made the
 * call, signed for the organization and caller the session is scoped to.
 *
 * Clients send a call's id back verbatim wherever its history goes: the same
 * session, a fork, or a summarizer that compacts the context in a session of
 * its own and hands the summary back. A request whose history carries a stamp
 * therefore names the trajectory that context came from, even under a new
 * session id, and the proxy continues that trajectory instead of opening a
 * clean root for context that is not clean. The proxy puts the provider's ids
 * back before anything reads the history, so the provider and the model only
 * ever see their own.
 *
 * Layout: `appat1`, then base64url(`<session id>\0<provider call id>`), then a
 * 22-character base64url HMAC-SHA256 tag (128 bits). Every character is one a
 * provider accepts in a call id (`[A-Za-z0-9_-]`), so a client that sanitizes
 * ids for its provider leaves a stamp intact.
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
 * The one session this caller's verified stamps name, if any. Stamps signed
 * for another caller or organization, or under another secret, name nothing:
 * that context was not this caller's to continue. A history that carries two
 * of this caller's sessions has no single trajectory to continue, and picking
 * one would drop the other's labels, so it is refused.
 */
export function stampedTrajectory(params: {
  stamps: readonly TrajectoryStamp[];
  organizationId: string;
  callerId: string;
  secret: string;
}): string | undefined {
  if (params.secret.length === 0) return undefined;
  const sessions = new Set(
    params.stamps
      .filter((stamp) => {
        const expected = Buffer.from(
          stampTag({ ...params, payload: stamp.payload }),
          "utf8",
        );
        const actual = Buffer.from(stamp.tag, "utf8");
        return (
          actual.length === expected.length && timingSafeEqual(actual, expected)
        );
      })
      .map((stamp) => stamp.sessionId),
  );
  if (sessions.size > 1) {
    throw new ApiError(
      400,
      "OpenAPPA cannot continue a history that carries calls from more than one session; resume one of those sessions instead",
    );
  }
  return sessions.values().next().value;
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
