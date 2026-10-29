import { conversationStorageKeys } from "@/lib/chat/chat-utils";

/**
 * Client-side helpers for encrypted chats.
 *
 * An encrypted chat is encrypted under a per-conversation key (DEK)
 * generated in the browser at creation time and kept ONLY in this browser's
 * localStorage — the server never stores it. Every request that touches the
 * conversation's content must carry the key in the
 * `x-archestra-encrypted-chat-key` header; without it the server returns a locked
 * tombstone view (`contentLocked: true`), and with a wrong key it returns 409.
 */

/** Header carrying the conversation DEK (mirrors the backend constant). */
export const ENCRYPTED_CHAT_KEY_HEADER = "x-archestra-encrypted-chat-key";

/**
 * Prefix of the chat-attachment byte endpoint. Bytes served from here are
 * sealed in an encrypted chat, so they are fetched with the key header rather than
 * linked directly — see `useAttachmentContentUrl`.
 */
export const ATTACHMENT_CONTENT_URL_PREFIX = "/api/chat/attachments/";

/**
 * Generate a fresh conversation DEK: 32 random bytes, base64url-encoded
 * without padding (the wire format the backend parses).
 *
 * Uses `crypto.getRandomValues`, which — unlike `crypto.randomUUID`, see
 * src/lib/uuid.ts — is available in non-secure contexts too, so plain-HTTP
 * deployments (e.g. `http://<lan-ip>:3000`) work without a fallback.
 */
export function generateEncryptedChatKey(): string {
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
export function storeEncryptedChatKey(
  conversationId: string,
  key: string,
): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(
      conversationStorageKeys(conversationId).encryptedChatKey,
      key,
    );
  } catch {
    // QuotaExceededError or private browsing restriction — the chat will show
    // the locked tombstone on reload, but the live session keeps working.
  }
}

/**
 * Read a conversation's stored DEK, or null when this browser has none.
 *
 * A stored value that is not a well-formed key (43 base64url chars = 32
 * bytes) is discarded and treated as absent: sending garbage in the header
 * gets a 400 from the backend's key parser, which the UI would misreport as
 * "conversation not found" — whereas sending no key at all yields the honest
 * locked-tombstone view.
 *
 * Keys written before the feature was renamed live under the old storage key;
 * they are moved across on first read. Skipping that would strand every chat
 * created before the rename, because this browser holds the only copy of its
 * key outside escrow.
 */
export function getEncryptedChatKey(conversationId: string): string | null {
  if (typeof window === "undefined") return null;
  try {
    const keys = conversationStorageKeys(conversationId);
    const storageKey = keys.encryptedChatKey;
    const value = localStorage.getItem(storageKey) ?? migrateLegacyKey(keys);
    if (value === null) return null;
    if (!/^[A-Za-z0-9_-]{43}$/.test(value)) {
      localStorage.removeItem(storageKey);
      return null;
    }
    return value;
  } catch {
    return null;
  }
}

/**
 * Headers to spread into any request touching the conversation's content
 * (chat stream, conversation GET, message edit, feedback). Returns undefined
 * when no key is stored — for a plain conversation that's the normal case,
 * and for an encrypted-chat one it lets the server answer with the tombstone.
 */
export function encryptedChatRequestHeaders(
  conversationId: string | null | undefined,
): Record<string, string> | undefined {
  if (!conversationId) return undefined;
  const key = getEncryptedChatKey(conversationId);
  return key ? { [ENCRYPTED_CHAT_KEY_HEADER]: key } : undefined;
}

/**
 * Actions the backend rejects for encrypted chats. Single source for the UI
 * affordances that must be hidden: sandbox `!` commands, share, fork,
 * create-project-from-chat, move-to-project, AI title generation, compaction,
 * and copying an attachment into a knowledge base.
 *
 * Attachments are deliberately NOT here — uploads work in an encrypted chat, sealed
 * under the conversation key.
 */
export type EncryptedChatBlockedAction =
  | "sandboxCommands"
  | "share"
  | "fork"
  | "createProject"
  | "changeProject"
  | "generateTitle"
  | "compaction"
  | "saveToKnowledge";

export type ConversationBlockedAction =
  | EncryptedChatBlockedAction
  | "rename"
  | "pin"
  | "export";

/**
 * Whether an action is available for a conversation. All of the
 * {@link EncryptedChatBlockedAction}s are unavailable on encrypted chats
 * (the backend rejects them); the action parameter documents intent at the
 * call site and keeps the block list greppable.
 */
export function isActionAvailableForConversation(
  conversation: { encryptedChat?: boolean } | null | undefined,
  action: ConversationBlockedAction,
): boolean {
  return (
    conversation?.encryptedChat !== true ||
    action === "rename" ||
    action === "pin" ||
    action === "export"
  );
}

// === Internal ===

/**
 * Move a pre-rename key to the current storage key and return it, or null
 * when this browser has none. Returns the raw value: `getEncryptedChatKey`
 * applies the same well-formedness check it applies to current-key reads.
 */
function migrateLegacyKey(
  keys: ReturnType<typeof conversationStorageKeys>,
): string | null {
  for (const legacyKey of keys.legacyEncryptedChatKeys) {
    const legacy = localStorage.getItem(legacyKey);
    if (legacy === null) continue;
    localStorage.setItem(keys.encryptedChatKey, legacy);
    for (const staleKey of keys.legacyEncryptedChatKeys) {
      localStorage.removeItem(staleKey);
    }
    return legacy;
  }
  return null;
}
