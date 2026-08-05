// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import { conversationStorageKeys } from "@/lib/chat/chat-utils";

/**
 * Client-side helpers for incognito chats.
 *
 * An incognito conversation is encrypted under a per-conversation key (DEK)
 * generated in the browser at creation time and kept ONLY in this browser's
 * localStorage — the server never stores it. Every request that touches the
 * conversation's content must carry the key in the
 * `x-archestra-incognito-key` header; without it the server returns a locked
 * tombstone view (`contentLocked: true`), and with a wrong key it returns 409.
 */

/** Header carrying the conversation DEK (mirrors the backend constant). */
export const INCOGNITO_KEY_HEADER = "x-archestra-incognito-key";

/**
 * Generate a fresh conversation DEK: 32 random bytes, base64url-encoded
 * without padding (the wire format the backend parses).
 *
 * Uses `crypto.getRandomValues`, which — unlike `crypto.randomUUID`, see
 * src/lib/uuid.ts — is available in non-secure contexts too, so plain-HTTP
 * deployments (e.g. `http://<lan-ip>:3000`) work without a fallback.
 */
export function generateIncognitoKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** Persist a conversation's DEK in this browser (swept on chat deletion). */
export function storeIncognitoKey(conversationId: string, key: string): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(
      conversationStorageKeys(conversationId).incognitoKey,
      key,
    );
  } catch {
    // QuotaExceededError or private browsing restriction — the chat will show
    // the locked tombstone on reload, but the live session keeps working.
  }
}

/** Read a conversation's stored DEK, or null when this browser has none. */
export function getIncognitoKey(conversationId: string): string | null {
  if (typeof window === "undefined") return null;
  try {
    return localStorage.getItem(
      conversationStorageKeys(conversationId).incognitoKey,
    );
  } catch {
    return null;
  }
}

/**
 * Headers to spread into any request touching the conversation's content
 * (chat stream, conversation GET, message edit, feedback). Returns undefined
 * when no key is stored — for a plain conversation that's the normal case,
 * and for an incognito one it lets the server answer with the tombstone.
 */
export function incognitoRequestHeaders(
  conversationId: string | null | undefined,
): Record<string, string> | undefined {
  if (!conversationId) return undefined;
  const key = getIncognitoKey(conversationId);
  return key ? { [INCOGNITO_KEY_HEADER]: key } : undefined;
}

/**
 * Actions the backend rejects for incognito conversations. Single source for
 * the UI affordances that must be hidden: attachments, sandbox `!` commands,
 * share, fork, create-project-from-chat, AI title generation, and compaction.
 */
export type IncognitoBlockedAction =
  | "attachments"
  | "sandboxCommands"
  | "share"
  | "fork"
  | "createProject"
  | "generateTitle"
  | "compaction";

/**
 * Whether an action is available for a conversation. All of the
 * {@link IncognitoBlockedAction}s are unavailable on incognito conversations
 * (the backend rejects them); the action parameter documents intent at the
 * call site and keeps the block list greppable.
 */
export function isActionAvailableForConversation(
  conversation: { incognito?: boolean } | null | undefined,
  _action: IncognitoBlockedAction,
): boolean {
  return conversation?.incognito !== true;
}
