// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import type { FastifyRequest } from "fastify";
import {
  INCOGNITO_KEY_HEADER,
  incognitoDekFingerprint,
  incognitoDekMatches,
  isIncognitoChatEnabled,
  parseIncognitoDekHeader,
  wrapIncognitoDek,
} from "@/content-encryption/incognito.ee";
import {
  ApiError,
  type ConversationContentKey,
  type IncognitoEscrowBlob,
} from "@/types";

/**
 * Request-side helpers for incognito conversations: header parsing, access
 * resolution, and creation bookkeeping. All key material stays request-scoped.
 */

export const INCOGNITO_STATIC_TITLE = "Incognito chat";

/** Error type surfaced on a present-but-wrong conversation key (409). */
export const INCOGNITO_KEY_MISMATCH_TYPE = "incognito_key_mismatch";

/**
 * Validate an incognito creation request and produce the row fields: the
 * caller must present the freshly generated DEK so it can be fingerprinted
 * and escrow-wrapped. Never returns the DEK for storage.
 */
export function resolveIncognitoCreation(params: {
  request: FastifyRequest;
  conversationId: string;
}): {
  incognito: true;
  incognitoDekFingerprint: string;
  incognitoEscrow: IncognitoEscrowBlob;
} {
  if (!isIncognitoChatEnabled()) {
    throw new ApiError(
      403,
      "Incognito chats are not enabled on this instance. They require an " +
        "enterprise license and a configured " +
        "ARCHESTRA_CHAT_INCOGNITO_ESCROW_PUBLIC_KEY.",
    );
  }
  const dek = readDekHeader(params.request);
  if (!dek) {
    throw new ApiError(
      400,
      `Incognito conversation creation requires the ${INCOGNITO_KEY_HEADER} header`,
    );
  }
  return {
    incognito: true,
    incognitoDekFingerprint: incognitoDekFingerprint(
      params.conversationId,
      dek,
    ),
    incognitoEscrow: wrapIncognitoDek(dek),
  };
}

export type IncognitoAccess =
  | { state: "plain" }
  | { state: "unlocked"; key: ConversationContentKey }
  | { state: "locked" };

/**
 * Resolve what the current request may see of a conversation's content.
 * Non-incognito conversations are always "plain". For incognito ones:
 * a valid key unlocks, an absent key yields the tombstone ("locked"), and a
 * present-but-wrong key is a 409 — the client's stored key does not belong
 * to this conversation, which is distinct from both "missing" and "forbidden".
 */
export function resolveIncognitoAccess(params: {
  request: FastifyRequest;
  conversation: {
    id: string;
    incognito: boolean;
    incognitoDekFingerprint: string | null;
  };
}): IncognitoAccess {
  if (!params.conversation.incognito) return { state: "plain" };

  const dek = readDekHeader(params.request);
  if (!dek) return { state: "locked" };

  const storedFingerprint = params.conversation.incognitoDekFingerprint;
  if (
    !storedFingerprint ||
    !incognitoDekMatches({
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
      "The provided incognito key does not match this conversation",
      INCOGNITO_KEY_MISMATCH_TYPE,
    );
  }
  return {
    state: "unlocked",
    key: { dek, conversationId: params.conversation.id },
  };
}

/**
 * Like resolveIncognitoAccess but for requests that MUST have the key
 * (streaming, message edits): "locked" is not an option.
 */
export function requireIncognitoKey(params: {
  request: FastifyRequest;
  conversation: {
    id: string;
    incognito: boolean;
    incognitoDekFingerprint: string | null;
  };
}): ConversationContentKey | null {
  const access = resolveIncognitoAccess(params);
  if (access.state === "plain") return null;
  if (access.state === "locked") {
    throw new ApiError(
      400,
      `This incognito conversation requires the ${INCOGNITO_KEY_HEADER} ` +
        "header — the key exists only in the browser that created the chat",
    );
  }
  return access.key;
}

// === Internal ===

function readDekHeader(request: FastifyRequest): Buffer | null {
  const raw = request.headers[INCOGNITO_KEY_HEADER];
  const value = Array.isArray(raw) ? raw[0] : raw;
  try {
    return parseIncognitoDekHeader(value);
  } catch (error) {
    throw new ApiError(
      400,
      error instanceof Error ? error.message : "invalid incognito key header",
    );
  }
}
