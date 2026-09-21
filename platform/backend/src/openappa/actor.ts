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

/** Extracts the client ID from a caller-scoped runtime session ID. */
export function clientSessionId(sessionId: string): string {
  const separator = sessionId.indexOf("|");
  return separator >= 0 ? sessionId.slice(separator + 1) : sessionId;
}
