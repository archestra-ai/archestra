/**
 * The two ways an incognito chat's audit content can be unavailable to a
 * reader, as stable shapes both the backend writer and the UI reader agree on.
 *
 * These are deliberately distinct, because they call for different words to
 * the person looking at the logs page:
 *
 * - LOCKED — the normal case. The content IS stored, encrypted under the
 *   conversation's browser-held key, and an operator holding the escrow
 *   private key can recover it offline. Nothing was lost.
 * - REDACTED — the fail-closed fallback. The content was never stored,
 *   because it could not be encrypted correctly at write time (no key on the
 *   request, a key that did not match the conversation, or no escrow record).
 *   Nothing can bring it back.
 *
 * Collapsing them into one marker would either promise recoverability that
 * does not exist, or hide recoverability that does.
 */

/** Content that was never stored. Not recoverable. */
export const INCOGNITO_REDACTED_MARKER = { __redacted: "incognito" } as const;

export type IncognitoRedactedContent = typeof INCOGNITO_REDACTED_MARKER;

/**
 * Content stored encrypted under the conversation key. Carries the
 * conversation id so a break-glass operator knows which escrow record opens
 * it (mcp_tool_calls rows have no other conversation reference).
 */
export type IncognitoLockedContent = {
  __incognitoLocked: string;
};

export function incognitoLockedContent(
  conversationId: string,
): IncognitoLockedContent {
  return { __incognitoLocked: conversationId };
}

export function isIncognitoLockedContent(
  value: unknown,
): value is IncognitoLockedContent {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as IncognitoLockedContent).__incognitoLocked === "string"
  );
}

export function isIncognitoRedactedContent(
  value: unknown,
): value is IncognitoRedactedContent {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as IncognitoRedactedContent).__redacted === "incognito"
  );
}

/** True for either unavailable-content shape. */
export function isIncognitoUnavailableContent(
  value: unknown,
): value is IncognitoLockedContent | IncognitoRedactedContent {
  return isIncognitoLockedContent(value) || isIncognitoRedactedContent(value);
}
