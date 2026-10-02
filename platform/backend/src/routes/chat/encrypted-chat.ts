import { randomUUID } from "node:crypto";
import type { FastifyRequest } from "fastify";
import {
  ENCRYPTED_CHAT_KEY_HEADER,
  encryptedChatDekFingerprint,
  encryptedChatDekMatches,
  isEncryptedChatEnabled,
  LEGACY_ENCRYPTED_CHAT_KEY_HEADERS,
  parseEncryptedChatDekHeader,
} from "@/content-encryption/encrypted-chat";
import { wrapEncryptedChatDek } from "@/content-encryption/encrypted-chat-escrow";
import type { ConversationContentKey, EncryptedChatEscrowBlob } from "@/types";
import { ApiError } from "@/types/api";

/**
 * Request-side helpers for encrypted chats: header parsing, access
 * resolution, and creation bookkeeping. All key material stays request-scoped.
 */

export const ENCRYPTED_CHAT_STATIC_TITLE = "Encrypted chat";

/** Error type surfaced on a present-but-wrong conversation key (409). */
export const ENCRYPTED_CHAT_KEY_MISMATCH_TYPE = "encrypted_chat_key_mismatch";

/**
 * Validate an encrypted-chat creation request and produce the row fields: the
 * caller must present the freshly generated DEK so it can be fingerprinted and
 * escrow-wrapped. Never returns the DEK for storage.
 *
 * The escrow record is mandatory, not optional: the conversation's audit trail
 * is encrypted under this DEK, so without an escrow copy it would be
 * recoverable by nobody. `isEncryptedChatEnabled()` already requires a
 * configured escrow key, so reaching the wrap below means one exists — a
 * failure there is fail-closed and no conversation is created.
 */
export function resolveEncryptedChatCreation(params: {
  request: FastifyRequest;
  conversationId: string;
}): {
  encryptedChat: true;
  encryptedChatDekFingerprint: string;
  encryptedChatEscrow: EncryptedChatEscrowBlob;
} {
  if (!isEncryptedChatEnabled()) {
    throw new ApiError(
      403,
      "Encrypted chats are not enabled on this instance. An operator enables " +
        "them by configuring ARCHESTRA_ENCRYPTED_CHAT_ESCROW_PUBLIC_KEY, " +
        "which keeps an offline-recoverable copy of each conversation key.",
    );
  }
  const dek = readDekHeader(params.request);
  if (!dek) {
    throw new ApiError(
      400,
      `Encrypted chat creation requires the ${ENCRYPTED_CHAT_KEY_HEADER} header`,
    );
  }
  return {
    encryptedChat: true,
    encryptedChatDekFingerprint: encryptedChatDekFingerprint(
      params.conversationId,
      dek,
    ),
    encryptedChatEscrow: wrapEncryptedChatDek(dek),
  };
}

/**
 * The encrypted-chat half of creating a conversation the SERVER assembles rather
 * than the composer — an app chat, which is opened by a POST from the browser
 * and so can carry the same key header the composer sends.
 *
 * Returns null when the request carries no key, which is the ordinary
 * (unlocked) open. When it does carry one, the conversation id is minted HERE:
 * the fingerprint and the escrow record are both bound to it, so it has to
 * exist before the row is written, exactly as it does on the composer path.
 *
 * The caller must both insert the conversation under this `conversationId` and
 * seal anything it seeds into the chat with `key`.
 */
export function resolveEncryptedChatCreationIfRequested(
  request: FastifyRequest,
): {
  conversationId: string;
  fields: ReturnType<typeof resolveEncryptedChatCreation>;
  key: ConversationContentKey;
} | null {
  const dek = readDekHeader(request);
  if (!dek) return null;
  const conversationId = randomUUID();
  return {
    conversationId,
    // Re-reads the header and re-validates that encrypted chats are enabled and
    // escrow is configured — a 403/400 here means no conversation is created.
    fields: resolveEncryptedChatCreation({ request, conversationId }),
    key: { dek, conversationId },
  };
}

export type EncryptedChatAccess =
  | { state: "plain" }
  | { state: "unlocked"; key: ConversationContentKey }
  | { state: "locked" };

/**
 * Resolve what the current request may see of a conversation's content.
 * Non-encrypted chats are always "plain". For encrypted-chat ones:
 * a valid key unlocks, an absent key yields the tombstone ("locked"), and a
 * present-but-wrong key is a 409 — the client's stored key does not belong
 * to this conversation, which is distinct from both "missing" and "forbidden".
 */
export function resolveEncryptedChatAccess(params: {
  request: FastifyRequest;
  conversation: {
    id: string;
    encryptedChat: boolean;
    encryptedChatDekFingerprint: string | null;
  };
}): EncryptedChatAccess {
  if (!params.conversation.encryptedChat) return { state: "plain" };

  const dek = readDekHeader(params.request);
  if (!dek) return { state: "locked" };

  const storedFingerprint = params.conversation.encryptedChatDekFingerprint;
  if (
    !storedFingerprint ||
    !encryptedChatDekMatches({
      storedFingerprint,
      conversationId: params.conversation.id,
      dek,
    })
  ) {
    // 409 (conflict), not 403: permissions are fine — the client's stored key
    // simply doesn't belong to this conversation. On these endpoints a 409 is
    // unambiguously a key mismatch.
    throw new ApiError(
      409,
      "The provided key does not match this encrypted chat",
      ENCRYPTED_CHAT_KEY_MISMATCH_TYPE,
    );
  }
  return {
    state: "unlocked",
    key: { dek, conversationId: params.conversation.id },
  };
}

/**
 * Like resolveEncryptedChatAccess but for requests that MUST have the key
 * (streaming, message edits): "locked" is not an option.
 */
export function requireEncryptedChatKey(params: {
  request: FastifyRequest;
  conversation: {
    id: string;
    encryptedChat: boolean;
    encryptedChatDekFingerprint: string | null;
  };
}): ConversationContentKey | null {
  const access = resolveEncryptedChatAccess(params);
  if (access.state === "plain") return null;
  if (access.state === "locked") {
    throw new ApiError(
      400,
      `This encrypted chat requires the ${ENCRYPTED_CHAT_KEY_HEADER} ` +
        "header — the key exists only in the browser that created the chat",
    );
  }
  return access.key;
}

// === Internal ===

function readDekHeader(request: FastifyRequest): Buffer | null {
  // Legacy spellings are read only as a fallback, so a browser tab loaded
  // before a rename keeps working; see LEGACY_ENCRYPTED_CHAT_KEY_HEADERS.
  const raw =
    request.headers[ENCRYPTED_CHAT_KEY_HEADER] ??
    LEGACY_ENCRYPTED_CHAT_KEY_HEADERS.map((name) => request.headers[name]).find(
      (value) => value !== undefined,
    );
  const value = Array.isArray(raw) ? raw[0] : raw;
  try {
    return parseEncryptedChatDekHeader(value);
  } catch (error) {
    throw new ApiError(
      400,
      error instanceof Error
        ? error.message
        : "invalid encrypted chat key header",
    );
  }
}
