import { createHmac, randomUUID } from "node:crypto";
import config from "@/config";

/**
 * The Codex session for one proxy request to the ChatGPT subscription
 * backend. The backend keeps the requests of one session on the same prompt
 * cache. The proxy builds a new client for every request, so the client
 * derives the session from the request's Archestra session: the agent run,
 * the conversation, or the ChatOps thread. A new session on each request puts
 * the steps of one run on different prompt caches.
 *
 * Each agent gets its own session. Delegated agents run in their parent's
 * Archestra session. OpenAI advises about 15 requests a minute on each cache
 * key, across all prompt prefixes. Above that rate, some requests go to
 * machines without the cache. A key for each agent keeps parallel agents from
 * sharing that rate.
 *
 * The upstream gets a UUID-shaped keyed hash, the shape Codex itself sends,
 * never the internal id. A request without a session gets a new random session
 * and no prompt cache key.
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

// ===== Internal helpers =====

/**
 * Key for the session hash, derived from the auth secret. Every replica must
 * send the same session for the same run. The upstream must not be able to
 * confirm a guessable Archestra session id, such as a ChatOps channel and
 * thread, from the hash. Without an auth secret the hash is unkeyed: runs
 * still keep one cache, but the ids are only obscured.
 */
const CODEX_SESSION_KEY = createHmac("sha256", config.auth.secret ?? "")
  .update("openai-codex-prompt-cache-session")
  .digest();
