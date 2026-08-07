import {
  createHash,
  createPublicKey,
  constants as cryptoConstants,
  type KeyObject,
  publicEncrypt,
} from "node:crypto";
import config from "@/config";
import type { IncognitoEscrowBlob, IncognitoEscrowWrappedDek } from "@/types";

/**
 * Key escrow for incognito chats: at conversation creation the browser-held
 * DEK is wrapped to an operator-configured RSA public key
 * (ARCHESTRA_CHAT_INCOGNITO_ESCROW_PUBLIC_KEY) whose private half is held
 * offline by the customer's security team. Recovering content is an explicit
 * break-glass procedure, not something the platform can do alone.
 *
 * Escrow is what ENABLES incognito chats: without it, a conversation's audit
 * trail (LLM interactions, MCP tool calls, chat errors, tool-execution claims,
 * replay payloads) would be encrypted under a key no one but that one browser
 * holds, which is unrecoverable rather than merely private — the opposite of
 * what an auditable deployment needs. So incognito is unavailable until an
 * escrow key is configured.
 *
 * Two sinks (ARCHESTRA_CHAT_INCOGNITO_ESCROW_SINK):
 * - `db` (default): the wrapped blob is stored inline on the conversation row.
 * - `vault`: Enterprise. The wrapped blob is written to HashiCorp Vault and
 *   the row stores only a reference marker (see incognito-escrow.ee.ts).
 */

/**
 * True when a usable escrow key is configured. This is the incognito
 * enablement gate — see {@link isIncognitoChatEnabled}.
 */
export function isIncognitoEscrowConfigured(): boolean {
  return escrowKeyOrNull() !== null;
}

/**
 * Boot-time validation, mirroring the content-encryption guard's posture: an
 * operator who configured escrow must never silently run with it ignored (bad
 * PEM, too-small key, or a Vault sink without the pieces it needs).
 */
export function verifyIncognitoChatConfig(): void {
  const pem = config.chatIncognito.escrowPublicKey;

  if (config.chatIncognito.escrowSink === "vault") {
    // SPDX-SnippetBegin
    // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
    // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
    if (!config.enterpriseFeatures.core) {
      throw new Error(
        "ARCHESTRA_CHAT_INCOGNITO_ESCROW_SINK=vault requires an enterprise " +
          "license. Unset the variable to use the default `db` sink, or " +
          "contact sales@archestra.ai.",
      );
    }
    if (config.secretsManager.type !== "VAULT") {
      throw new Error(
        "ARCHESTRA_CHAT_INCOGNITO_ESCROW_SINK=vault requires " +
          "ARCHESTRA_SECRETS_MANAGER=Vault (the escrow blob is written to " +
          "the configured HashiCorp Vault secrets backend).",
      );
    }
    // SPDX-SnippetEnd
    if (!pem) {
      throw new Error(
        "ARCHESTRA_CHAT_INCOGNITO_ESCROW_SINK=vault requires " +
          "ARCHESTRA_CHAT_INCOGNITO_ESCROW_PUBLIC_KEY to be configured — " +
          "there is no escrow blob to write without an escrow key.",
      );
    }
  }

  if (!pem) return;

  // Throws with the parse/size problem named.
  loadEscrowKey(pem);
}

/**
 * Produce the escrow record for a new incognito conversation: wrap the DEK to
 * the escrow key and either return the blob for inline (db-sink) storage or
 * write it to Vault and return the reference marker. Callers must have checked
 * {@link isIncognitoEscrowConfigured} first. Fail closed: a Vault write
 * failure throws (500) so the conversation is never created without its
 * escrow copy.
 */
export async function produceIncognitoEscrow(params: {
  dek: Buffer;
  conversationId: string;
}): Promise<IncognitoEscrowBlob> {
  const wrapped = wrapIncognitoDek(params.dek);
  if (config.chatIncognito.escrowSink !== "vault") {
    return wrapped;
  }
  // SPDX-SnippetBegin
  // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
  // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
  const { writeEscrowBlobToVault } = await import("./incognito-escrow.ee");
  const path = await writeEscrowBlobToVault({
    conversationId: params.conversationId,
    blob: wrapped,
  });
  return { v: 1, sink: "vault", path };
  // SPDX-SnippetEnd
}

/**
 * Wrap a DEK to the escrow public key. RSA-OAEP with an EXPLICIT sha256 —
 * Node's default OAEP hash is SHA-1. The blob is versioned so the offline
 * recovery procedure is unambiguous.
 * @public — exported so tests can pin the exact offline recovery contract
 */
export function wrapIncognitoDek(dek: Buffer): IncognitoEscrowWrappedDek {
  const key = escrowKeyOrNull();
  if (!key) {
    throw new Error(
      "incognito escrow public key is not configured — this is a bug in the " +
        "enablement gating",
    );
  }
  const wrapped = publicEncrypt(
    {
      key,
      padding: cryptoConstants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: "sha256",
    },
    dek,
  );
  return {
    v: 1,
    alg: "RSA-OAEP-256",
    escrowKeyFingerprint: escrowKeyFingerprint(key),
    wrappedDek: wrapped.toString("base64"),
  };
}

// === Internal ===

const MIN_ESCROW_MODULUS_BITS = 2048;

let cachedEscrowKey: KeyObject | null = null;
let cachedEscrowKeyPem: string | null = null;

function escrowKeyOrNull(): KeyObject | null {
  const pem = config.chatIncognito.escrowPublicKey;
  if (!pem) return null;
  if (cachedEscrowKey && cachedEscrowKeyPem === pem) return cachedEscrowKey;
  try {
    cachedEscrowKey = loadEscrowKey(pem);
    cachedEscrowKeyPem = pem;
    return cachedEscrowKey;
  } catch {
    // Invalid key: the boot guard rejects this at startup; treat escrow
    // as unconfigured rather than half-working if it is somehow reached.
    return null;
  }
}

function loadEscrowKey(pem: string): KeyObject {
  // Tolerate env-var PEMs with literal "\n" sequences.
  const normalized = pem.includes("-----")
    ? pem.replace(/\\n/g, "\n")
    : Buffer.from(pem, "base64").toString("utf8");
  const key = createPublicKey(normalized);
  if (key.asymmetricKeyType !== "rsa") {
    throw new Error(
      "ARCHESTRA_CHAT_INCOGNITO_ESCROW_PUBLIC_KEY must be an RSA public key " +
        `(got ${key.asymmetricKeyType})`,
    );
  }
  const modulusBits = key.asymmetricKeyDetails?.modulusLength ?? 0;
  if (modulusBits < MIN_ESCROW_MODULUS_BITS) {
    throw new Error(
      `ARCHESTRA_CHAT_INCOGNITO_ESCROW_PUBLIC_KEY must be at least ` +
        `${MIN_ESCROW_MODULUS_BITS} bits (got ${modulusBits})`,
    );
  }
  return key;
}

function escrowKeyFingerprint(key: KeyObject): string {
  const der = key.export({ type: "spki", format: "der" });
  return createHash("sha256").update(der).digest("hex").slice(0, 16);
}
