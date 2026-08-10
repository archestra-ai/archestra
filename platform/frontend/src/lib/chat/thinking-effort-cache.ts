// Publishes the composer's reasoning-depth pick where an outgoing turn can read
// it, including turns the composer does not send itself — a queued message
// draining after a stream, or a regenerate.
//
// The pick is kept beside the cached conversation rather than on it. Finishing a
// message invalidates that query, and the refetch returns whatever row the
// persist request has not reached yet — which would replace the user's pick with
// the value they just moved away from.
//
// The composer's own state is the source; this is a projection of it, written by
// one effect. Nothing here decides anything, so the control and the turn cannot
// drift apart the way two independently-updated copies did.

import type { archestraApiTypes, ThinkingEffort } from "@archestra/shared";

/** The minimum surface of a TanStack query client this module needs. */
type EffortCache = {
  getQueryData: <T>(queryKey: readonly unknown[]) => T | undefined;
  setQueryData: <T>(queryKey: readonly unknown[], updater: T) => unknown;
};

type CachedConversation = archestraApiTypes.GetChatConversationResponses["200"];

const conversationKey = (conversationId: string) =>
  ["conversation", conversationId] as const;

const pendingKey = (conversationId: string) =>
  ["conversation", conversationId, "pending-thinking-effort"] as const;

/** The depth a turn should carry: the unconfirmed pick, else the stored row. */
export function readThinkingEffort(
  cache: EffortCache,
  conversationId: string,
): ThinkingEffort | undefined {
  return (
    cache.getQueryData<ThinkingEffort | null>(pendingKey(conversationId)) ??
    cache.getQueryData<CachedConversation>(conversationKey(conversationId))
      ?.thinkingEffort
  );
}

/**
 * Mirror the composer's current pick, or `null` once the server has answered.
 *
 * `null` rather than `undefined` on purpose: TanStack treats an undefined value
 * as "no update" and returns without touching the cache, so clearing with it
 * leaves the old pick in place and every later turn reads a depth the composer
 * has already abandoned.
 */
export function writePendingThinkingEffort(
  cache: EffortCache,
  conversationId: string,
  effort: ThinkingEffort | null,
): void {
  cache.setQueryData(pendingKey(conversationId), effort);
}

/** Record a confirmed write on the conversation the rest of the app reads. */
export function foldConfirmedThinkingEffort(
  cache: EffortCache,
  conversationId: string,
  effort: ThinkingEffort,
): void {
  const conversation = cache.getQueryData<CachedConversation>(
    conversationKey(conversationId),
  );
  if (conversation) {
    cache.setQueryData(conversationKey(conversationId), {
      ...conversation,
      thinkingEffort: effort,
    });
  }
}
