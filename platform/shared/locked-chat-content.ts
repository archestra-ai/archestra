/**
 * The two ways a locked chat's audit content can be unavailable to a
 * reader, as stable shapes both the backend writer and the UI reader agree on.
 *
 * These are deliberately distinct, because they call for different words to
 * the person looking at the logs page:
 *
 * - SEALED — the normal case. The content IS stored, encrypted under the
 *   conversation's browser-held key, and an operator holding the escrow
 *   private key can recover it offline. Nothing was lost.
 * - REDACTED — the fail-closed fallback. The content was never stored,
 *   because it could not be encrypted correctly at write time (no key on the
 *   request, a key that did not match the conversation, or no escrow record).
 *   Nothing can bring it back.
 *
 * Collapsing them into one marker would either promise recoverability that
 * does not exist, or hide recoverability that does.
 *
 * "Sealed" rather than "locked" is deliberate: the feature itself is now
 * called a locked chat, so reusing the word for one of its two failure states
 * would name this type `LockedChatLockedContent`, which reads as a typo.
 */

/** Content that was never stored. Not recoverable. */
export const LOCKED_CHAT_REDACTED_MARKER = {
  __redacted: "locked_chat",
} as const;

/**
 * The marker value written before the feature was renamed. Rows carrying it
 * are still on disk, so readers must recognize it; nothing writes it.
 */
const LEGACY_LOCKED_CHAT_REDACTED_VALUE = "incognito";

/**
 * Every `__redacted` value a stored row may carry, current spelling first.
 * Read schemas validate persisted content, so they have to admit the legacy
 * value as well — hence a shared list rather than a literal at each site.
 */
export const LOCKED_CHAT_REDACTED_VALUES = [
  LOCKED_CHAT_REDACTED_MARKER.__redacted,
  LEGACY_LOCKED_CHAT_REDACTED_VALUE,
] as const;

/**
 * Admits both spellings, so it matches what a read schema produces for a
 * stored row — `WithoutLockedChatUnavailable` narrows by exact shape, and a
 * single-literal type here would no longer subtract that union member.
 */
export type LockedChatRedactedContent = {
  __redacted: (typeof LOCKED_CHAT_REDACTED_VALUES)[number];
};

/**
 * Content stored encrypted under the conversation key. Carries the
 * conversation id so a break-glass operator knows which escrow record opens
 * it (mcp_tool_calls rows have no other conversation reference).
 */
export type LockedChatSealedContent = {
  __lockedChatSealed: string;
};

export function lockedChatSealedContent(
  conversationId: string,
): LockedChatSealedContent {
  return { __lockedChatSealed: conversationId };
}

export function isLockedChatSealedContent(
  value: unknown,
): value is LockedChatSealedContent {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as LockedChatSealedContent).__lockedChatSealed === "string"
  );
}

export function isLockedChatRedactedContent(
  value: unknown,
): value is LockedChatRedactedContent {
  if (typeof value !== "object" || value === null) return false;
  const marker = (value as LockedChatRedactedContent).__redacted;
  return (
    marker === LOCKED_CHAT_REDACTED_MARKER.__redacted ||
    marker === LEGACY_LOCKED_CHAT_REDACTED_VALUE
  );
}

/** True for either unavailable-content shape. */
export function isLockedChatUnavailableContent(
  value: unknown,
): value is LockedChatSealedContent | LockedChatRedactedContent {
  return isLockedChatSealedContent(value) || isLockedChatRedactedContent(value);
}

/**
 * Drops the unavailable-content shapes from a persisted content union.
 *
 * Read schemas admit them so a sealed or redacted row still serializes, which
 * widens every provider payload type. Mappers only ever run on real content —
 * `DynamicInteraction` short-circuits before delegating — so they narrow with
 * this rather than each re-deriving the exclusion.
 */
export type WithoutLockedChatUnavailable<T> = Exclude<
  T,
  LockedChatSealedContent | LockedChatRedactedContent
>;
