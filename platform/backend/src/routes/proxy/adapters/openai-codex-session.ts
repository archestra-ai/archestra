import { createHash, randomUUID } from "node:crypto";

/**
 * The Codex session for one proxy request to the ChatGPT subscription
 * backend. The backend keeps the requests of one session on the same prompt
 * cache. The proxy builds a new client for every request, so the session must
 * come from the request's Archestra session (the agent run or the
 * conversation): a new session on each request spreads the steps of one run
 * over different prompt caches.
 *
 * The upstream gets a UUID-shaped hash, the shape Codex itself sends, never
 * the internal id (a ChatOps session id names its channel). A request without
 * a session gets a new random session and no prompt cache key.
 */
export function resolveCodexSession(archestraSessionId: string | undefined): {
  sessionId: string;
  promptCacheKey: string | undefined;
} {
  if (!archestraSessionId) {
    return { sessionId: randomUUID(), promptCacheKey: undefined };
  }
  const hex = createHash("sha256").update(archestraSessionId).digest("hex");
  const variant = ((Number.parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  const sessionId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
  return { sessionId, promptCacheKey: sessionId };
}
