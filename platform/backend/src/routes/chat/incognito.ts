import type { FastifyRequest } from "fastify";
import {
  INCOGNITO_KEY_HEADER,
  incognitoDekFingerprint,
  incognitoDekMatches,
  isIncognitoChatEnabled,
  parseIncognitoDekHeader,
} from "@/content-encryption/incognito";
import {
  isIncognitoEscrowConfigured,
  produceIncognitoEscrow,
  // biome-ignore lint/style/noRestrictedImports: dual-licensed; escrow is enterprise-only and skipped when unconfigured
} from "@/content-encryption/incognito-escrow.ee";
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
 * (and, when enterprise escrow is configured, escrow-wrapped — including the
 * Vault-sink write, which is why this is async and needs the pre-generated
 * conversation id). Never returns the DEK for storage. `incognitoEscrow` is
 * null when no escrow key is configured: the free feature stores no
 * recoverable copy of the key.
 */
export async function resolveIncognitoCreation(params: {
  request: FastifyRequest;
  conversationId: string;
}): Promise<{
  incognito: true;
  incognitoDekFingerprint: string;
  incognitoEscrow: IncognitoEscrowBlob | null;
}> {
  if (!isIncognitoChatEnabled()) {
    throw new ApiError(
      403,
      "Incognito chats are disabled on this instance " +
        "(ARCHESTRA_CHAT_INCOGNITO_ENABLED=false).",
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
    incognitoEscrow: isIncognitoEscrowConfigured()
      ? await produceIncognitoEscrow({
          dek,
          conversationId: params.conversationId,
        })
      : null,
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
