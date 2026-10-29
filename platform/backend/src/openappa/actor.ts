import { createHash } from "node:crypto";

/**
 * Calculates the actor ID for a caller-scoped session ID.
 * This ID keys the `openappa_sessions` row and defines the root for a non-child session.
 * The native binding (`session_actor`) uses the same hash.
 */
export function openappaActor(sessionId: string): string {
  return `archestra:${createHash("sha256").update(sessionId).digest("hex")}`;
}

/** Builds a caller-scoped runtime session ID (`<caller>|<client id>`). */
export function scopedSessionId(callerId: string, sessionId: string): string {
  return `${callerId}|${sessionId}`;
}

/**
 * Builds a child's session ID: its parent's ID, a colon, and the ID the client
 * gave the child. Every client's children get their IDs this way.
 */
export function childSessionId(
  parentId: string,
  childNativeId: string,
): string {
  return `${parentId}:${childNativeId}`;
}

/** Extracts the client ID from a caller-scoped runtime session ID. */
export function clientSessionId(sessionId: string): string {
  const separator = sessionId.indexOf("|");
  return separator >= 0 ? sessionId.slice(separator + 1) : sessionId;
}

/** Recovers the existing cache scope, not an authorization claim. */
export function sessionCallerId(sessionId: string): string | undefined {
  const separator = sessionId.indexOf("|");
  if (separator <= 0) return undefined;
  const caller = sessionId.slice(0, separator);
  return /^(user|app|virtual-key):.+$/.test(caller) ? caller : undefined;
}
