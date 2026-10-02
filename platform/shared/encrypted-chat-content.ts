/**
 * The two ways an encrypted chat's audit content can be unavailable to a
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
 * "Sealed" rather than "locked" is deliberate: "locked" already names the
 * UI's tombstone state (`contentLocked`), so reusing it here would blur the
 * two failure states together.
 */

/** Content that was never stored. Not recoverable. */
export const ENCRYPTED_CHAT_REDACTED_MARKER = {
  __redacted: "encrypted_chat",
} as const;

/**
 * Marker values written under the feature's former names ("locked chat", then
 * "incognito"). Rows carrying them are still on disk, so readers must
 * recognize them; nothing writes them.
 */
const LEGACY_ENCRYPTED_CHAT_REDACTED_VALUES = [
  "locked_chat",
  "incognito",
] as const;

/**
 * Every `__redacted` value a stored row may carry, current spelling first.
 * Read schemas validate persisted content, so they have to admit the legacy
 * value as well — hence a shared list rather than a literal at each site.
 */
export const ENCRYPTED_CHAT_REDACTED_VALUES = [
  ENCRYPTED_CHAT_REDACTED_MARKER.__redacted,
  ...LEGACY_ENCRYPTED_CHAT_REDACTED_VALUES,
] as const;

/**
 * Admits every spelling, so it matches what a read schema produces for a
 * stored row — `WithoutEncryptedChatUnavailable` narrows by exact shape, and a
 * single-literal type here would no longer subtract that union member.
 */
export type EncryptedChatRedactedContent = {
  __redacted: (typeof ENCRYPTED_CHAT_REDACTED_VALUES)[number];
};

/**
 * Content stored encrypted under the conversation key. Carries the
 * conversation id so a break-glass operator knows which escrow record opens
 * it (mcp_tool_calls rows have no other conversation reference).
 */
export type EncryptedChatSealedContent = {
  __encryptedChatSealed: string;
};

export function encryptedChatSealedContent(
  conversationId: string,
): EncryptedChatSealedContent {
  return { __encryptedChatSealed: conversationId };
}

export function isEncryptedChatSealedContent(
  value: unknown,
): value is EncryptedChatSealedContent {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as EncryptedChatSealedContent).__encryptedChatSealed ===
      "string"
  );
}

export function isEncryptedChatRedactedContent(
  value: unknown,
): value is EncryptedChatRedactedContent {
  if (typeof value !== "object" || value === null) return false;
  const marker = (value as EncryptedChatRedactedContent).__redacted;
  return (ENCRYPTED_CHAT_REDACTED_VALUES as readonly unknown[]).includes(
    marker,
  );
}

/** True for either unavailable-content shape. */
export function isEncryptedChatUnavailableContent(
  value: unknown,
): value is EncryptedChatSealedContent | EncryptedChatRedactedContent {
  return (
    isEncryptedChatSealedContent(value) || isEncryptedChatRedactedContent(value)
  );
}

/**
 * Drops the unavailable-content shapes from a persisted content union.
 *
 * Read schemas admit them so a sealed or redacted row still serializes, which
 * widens every provider payload type. Mappers only ever run on real content —
 * `DynamicInteraction` short-circuits before delegating — so they narrow with
 * this rather than each re-deriving the exclusion.
 */
export type WithoutEncryptedChatUnavailable<T> = Exclude<
  T,
  EncryptedChatSealedContent | EncryptedChatRedactedContent
>;
