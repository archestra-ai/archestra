import { type InteractionSource, TimeInMs } from "@archestra/shared";
import { CacheKey, cacheManager } from "@/cache-manager";
import logger from "@/logging";
import { ConversationModel } from "@/models";
import type {
  InsertInteraction,
  InteractionRequest,
  InteractionResponse,
} from "@/types";
import { isLoopbackAddress } from "@/utils/network";

/**
 * LLM-proxy side of incognito chats: decide whether a request belongs to an
 * incognito chat session (so its stored interaction content and span content
 * must be suppressed), and build the redacted interaction record.
 */

/**
 * Marker persisted in place of conversation content for incognito chat
 * sessions. The shape is deliberately stable so log surfaces can detect it.
 */
export const INCOGNITO_REDACTED_MARKER = { __redacted: "incognito" } as const;

/** TTL for positive incognito lookups; the flag is immutable per conversation. */
const INCOGNITO_SESSION_CACHE_TTL_MS = TimeInMs.Minute;

/**
 * Whether this proxy request belongs to an incognito chat conversation.
 *
 * Detection is server-derived — never trusted from spoofable public headers
 * alone: only requests that arrived over the loopback path the in-app chat
 * uses (source === "chat" is set by the chat backend on its in-process
 * proxy call, and the session id equals the conversation id there) qualify
 * for the lookup, and the conversation must be owned by the request's user.
 * A forged combination can at worst redact the forger's own interaction —
 * the owner check keeps it from suppressing anyone else's audit trail.
 *
 * FAIL CLOSED: a lookup error is treated as incognito (content redacted)
 * rather than risking a plaintext write for a genuine incognito session.
 * Only positive results are cached, so a transient failure never pins a
 * session as non-incognito.
 */
export async function isIncognitoChatSession(params: {
  source: InteractionSource;
  requestIp: string | undefined;
  sessionId: string | null | undefined;
  userId: string | undefined;
}): Promise<boolean> {
  const { source, requestIp, sessionId, userId } = params;
  // "chat" plus chat:* subrequests (e.g. chat:tool_call_repair — a repair
  // prompt carries the same conversation content as the turn it repairs).
  // NOT chatops:* — those are unrelated messaging-channel sessions.
  if (
    (source !== "chat" && !source?.startsWith("chat:")) ||
    !sessionId ||
    !userId ||
    !isLoopbackAddress(requestIp)
  ) {
    return false;
  }

  const cacheKey =
    `${CacheKey.IncognitoChatSession}-${sessionId}:${userId}` as const;
  try {
    const cached = await cacheManager.get<boolean>(cacheKey);
    if (cached === true) {
      return true;
    }

    const incognito = await ConversationModel.isIncognitoOwnedBy({
      id: sessionId,
      userId,
    });
    if (incognito) {
      // Positive results only: the flag is immutable once set at creation, so
      // a cached `true` can never go stale; a `false` could mask a race with
      // conversation creation and must always be re-derived.
      await cacheManager.set(cacheKey, true, INCOGNITO_SESSION_CACHE_TTL_MS);
    }
    return incognito;
  } catch (error) {
    logger.warn(
      { error, sessionId },
      "Incognito chat session lookup failed; failing closed (redacting interaction content)",
    );
    return true;
  }
}

/**
 * Replace the content-bearing fields of an interaction record with the
 * incognito redaction marker (or null where the column is nullable), keeping
 * every usage/cost/model/session metadata field intact so usage accounting
 * and cost limits keep working.
 */
export function redactIncognitoInteraction(
  record: InsertInteraction,
): InsertInteraction {
  return {
    ...record,
    request: INCOGNITO_REDACTED_MARKER as unknown as InteractionRequest,
    processedRequest: null,
    response: INCOGNITO_REDACTED_MARKER as unknown as InteractionResponse,
    dualLlmAnalyses: null,
    unsafeContextBoundary: null,
  };
}
