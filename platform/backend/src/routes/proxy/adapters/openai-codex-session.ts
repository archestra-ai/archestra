import { createHmac, randomUUID } from "node:crypto";
import config from "@/config";

/**
 * Key for the session hash, derived from the auth secret. Every replica must
 * send the same session for the same run, and a guessable Archestra session id
 * (a chat id) must not be confirmable from its hash. Without an auth secret
 * the hash is unkeyed: runs still keep one cache, but the ids are only
 * obscured.
 */
const CODEX_SESSION_KEY = createHmac("sha256", config.auth.secret ?? "")
  .update("openai-codex-prompt-cache-session")
  .digest();

/**
 * The Codex session for one proxy request to the ChatGPT subscription
 * backend. The backend keeps the requests of one session on the same prompt
 * cache. The proxy builds a new client for every request, so the session must
 * come from the request's Archestra session (the agent run or the
 * conversation): a new session on each request spreads the steps of one run
 * over different prompt caches.
 *
 * Each agent gets its own session. Delegated agents share their parent's
 * Archestra session, and above about 15 requests a minute on one cache key
 * and prompt prefix, OpenAI routes some requests to machines without the
 * cache.
 *
 * The upstream gets a UUID-shaped keyed hash, the shape Codex itself sends,
 * never the internal id (a ChatOps session id names its channel). A request
 * without a session gets a new random session and no prompt cache key.
 */
export function resolveCodexSession(params: {
  archestraSessionId: string | undefined;
  agentId: string | undefined;
}): {
  sessionId: string;
  promptCacheKey: string | undefined;
} {
  const { archestraSessionId, agentId } = params;
  if (!archestraSessionId) {
    return { sessionId: randomUUID(), promptCacheKey: undefined };
  }
  const hex = createHmac("sha256", CODEX_SESSION_KEY)
    .update(agentId ?? "")
    .update("\0")
    .update(archestraSessionId)
    .digest("hex");
  const variant = ((Number.parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  const sessionId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
  return { sessionId, promptCacheKey: sessionId };
}
