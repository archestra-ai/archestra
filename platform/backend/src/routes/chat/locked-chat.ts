import { randomUUID } from "node:crypto";
import type { FastifyRequest } from "fastify";
import {
  isLockedChatEnabled,
  LEGACY_LOCKED_CHAT_KEY_HEADER,
  LOCKED_CHAT_KEY_HEADER,
  lockedChatDekFingerprint,
  lockedChatDekMatches,
  parseLockedChatDekHeader,
} from "@/content-encryption/locked-chat";
import { wrapLockedChatDek } from "@/content-encryption/locked-chat-escrow";
import {
  ApiError,
  type ConversationContentKey,
  type LockedChatEscrowBlob,
} from "@/types";

/**
 * Request-side helpers for locked chats: header parsing, access
 * resolution, and creation bookkeeping. All key material stays request-scoped.
 */

export const LOCKED_CHAT_STATIC_TITLE = "Locked chat";

/** Error type surfaced on a present-but-wrong conversation key (409). */
export const LOCKED_CHAT_KEY_MISMATCH_TYPE = "locked_chat_key_mismatch";

/**
 * Validate a locked-chat creation request and produce the row fields: the
 * caller must present the freshly generated DEK so it can be fingerprinted and
 * escrow-wrapped. Never returns the DEK for storage.
 *
 * The escrow record is mandatory, not optional: the conversation's audit trail
 * is encrypted under this DEK, so without an escrow copy it would be
 * recoverable by nobody. `isLockedChatEnabled()` already requires a
 * configured escrow key, so reaching the wrap below means one exists — a
 * failure there is fail-closed and no conversation is created.
 */
export function resolveLockedChatCreation(params: {
  request: FastifyRequest;
  conversationId: string;
}): {
  lockedChat: true;
  lockedChatDekFingerprint: string;
  lockedChatEscrow: LockedChatEscrowBlob;
} {
  if (!isLockedChatEnabled()) {
    throw new ApiError(
      403,
      "Locked chats are not enabled on this instance. An operator enables " +
        "them by configuring ARCHESTRA_LOCKED_CHAT_ESCROW_PUBLIC_KEY, " +
        "which keeps an offline-recoverable copy of each conversation key.",
    );
  }
  const dek = readDekHeader(params.request);
  if (!dek) {
    throw new ApiError(
      400,
      `Locked chat creation requires the ${LOCKED_CHAT_KEY_HEADER} header`,
    );
  }
  return {
    lockedChat: true,
    lockedChatDekFingerprint: lockedChatDekFingerprint(
      params.conversationId,
      dek,
    ),
    lockedChatEscrow: wrapLockedChatDek(dek),
  };
}

/**
 * The locked-chat half of creating a conversation the SERVER assembles rather
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
export function resolveLockedChatCreationIfRequested(request: FastifyRequest): {
  conversationId: string;
  fields: ReturnType<typeof resolveLockedChatCreation>;
  key: ConversationContentKey;
} | null {
  const dek = readDekHeader(request);
  if (!dek) return null;
  const conversationId = randomUUID();
  return {
    conversationId,
    // Re-reads the header and re-validates that locked chats are enabled and
    // escrow is configured — a 403/400 here means no conversation is created.
    fields: resolveLockedChatCreation({ request, conversationId }),
    key: { dek, conversationId },
  };
}

export type LockedChatAccess =
  | { state: "plain" }
  | { state: "unlocked"; key: ConversationContentKey }
  | { state: "locked" };

/**
 * Resolve what the current request may see of a conversation's content.
 * Non-locked chats are always "plain". For locked-chat ones:
 * a valid key unlocks, an absent key yields the tombstone ("locked"), and a
 * present-but-wrong key is a 409 — the client's stored key does not belong
 * to this conversation, which is distinct from both "missing" and "forbidden".
 */
export function resolveLockedChatAccess(params: {
  request: FastifyRequest;
  conversation: {
    id: string;
    lockedChat: boolean;
    lockedChatDekFingerprint: string | null;
  };
}): LockedChatAccess {
  if (!params.conversation.lockedChat) return { state: "plain" };

  const dek = readDekHeader(params.request);
  if (!dek) return { state: "locked" };

  const storedFingerprint = params.conversation.lockedChatDekFingerprint;
  if (
    !storedFingerprint ||
    !lockedChatDekMatches({
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
      "The provided key does not match this locked chat",
      LOCKED_CHAT_KEY_MISMATCH_TYPE,
    );
  }
  return {
    state: "unlocked",
    key: { dek, conversationId: params.conversation.id },
  };
}

/**
 * Like resolveLockedChatAccess but for requests that MUST have the key
 * (streaming, message edits): "locked" is not an option.
 */
export function requireLockedChatKey(params: {
  request: FastifyRequest;
  conversation: {
    id: string;
    lockedChat: boolean;
    lockedChatDekFingerprint: string | null;
  };
}): ConversationContentKey | null {
  const access = resolveLockedChatAccess(params);
  if (access.state === "plain") return null;
  if (access.state === "locked") {
    throw new ApiError(
      400,
      `This locked chat requires the ${LOCKED_CHAT_KEY_HEADER} ` +
        "header — the key exists only in the browser that created the chat",
    );
  }
  return access.key;
}

// === Internal ===

function readDekHeader(request: FastifyRequest): Buffer | null {
  // The legacy spelling is read only as a fallback, so a browser tab loaded
  // before the rename keeps working; see LEGACY_LOCKED_CHAT_KEY_HEADER.
  const raw =
    request.headers[LOCKED_CHAT_KEY_HEADER] ??
    request.headers[LEGACY_LOCKED_CHAT_KEY_HEADER];
  const value = Array.isArray(raw) ? raw[0] : raw;
  try {
    return parseLockedChatDekHeader(value);
  } catch (error) {
    throw new ApiError(
      400,
      error instanceof Error ? error.message : "invalid locked chat key header",
    );
  }
}
