import { createHash } from "node:crypto";

/**
 * The runtime's actor id for a caller-scoped session id: the key of its
 * `openappa_sessions` row, and the root of a session that is not a child.
 * Computed the same way by the native binding (`session_actor`).
 */
export function openappaActor(sessionId: string): string {
  return `archestra:${createHash("sha256").update(sessionId).digest("hex")}`;
}
