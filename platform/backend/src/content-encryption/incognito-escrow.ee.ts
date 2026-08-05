// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import {
  createHash,
  createPublicKey,
  constants as cryptoConstants,
  type KeyObject,
  publicEncrypt,
} from "node:crypto";
import { SecretsManagerType } from "@archestra/shared";
import config from "@/config";
import logger from "@/logging";
import { secretManager } from "@/secrets-manager";
import type VaultSecretManager from "@/secrets-manager/vault.ee";
import {
  ApiError,
  type IncognitoEscrowBlob,
  type IncognitoEscrowWrappedDek,
} from "@/types";

/**
 * Enterprise escrow for incognito chats: at conversation creation the
 * browser-held DEK is wrapped to an operator-configured RSA public key
 * (ARCHESTRA_CHAT_INCOGNITO_ESCROW_PUBLIC_KEY) whose private half is held
 * offline by the customer's security team. Recovering content is an explicit
 * break-glass procedure, not something the platform can do alone.
 *
 * Two sinks (ARCHESTRA_CHAT_INCOGNITO_ESCROW_SINK):
 * - `db` (default): the wrapped blob is stored inline on the conversation row.
 * - `vault`: the wrapped blob is written to the configured HashiCorp Vault
 *   backend at `incognito-escrow/<conversationId>` (under the configured
 *   secret path prefix) and the row stores only a reference marker. The
 *   platform only ever WRITES that path — a create-only Vault policy makes it
 *   write-only from the app's perspective. A failed Vault write fails the
 *   conversation creation (fail closed), before any row is inserted.
 *
 * The base incognito feature (content-encryption/incognito.ts) is free and
 * works without any of this — it then stores no recoverable key copy at all.
 */

/**
 * True when escrow is active: EE license plus a valid escrow public key.
 * The free incognito feature stores no escrow when this is false.
 */
export function isIncognitoEscrowConfigured(): boolean {
  return Boolean(config.enterpriseFeatures.core && escrowKeyOrNull());
}

/**
 * Boot-time validation, mirroring the content-encryption guard's posture:
 * an operator who configured escrow must never silently run with it ignored
 * (bad PEM, too-small key, missing license, or a Vault sink without the
 * pieces it needs).
 */
export function verifyIncognitoChatConfig(): void {
  const pem = config.chatIncognito.escrowPublicKey;

  if (config.chatIncognito.escrowSink === "vault") {
    if (!config.enterpriseFeatures.core) {
      throw new Error(
        "ARCHESTRA_CHAT_INCOGNITO_ESCROW_SINK=vault requires an enterprise " +
          "license. Unset the variable or contact sales@archestra.ai.",
      );
    }
    if (!pem) {
      throw new Error(
        "ARCHESTRA_CHAT_INCOGNITO_ESCROW_SINK=vault requires " +
          "ARCHESTRA_CHAT_INCOGNITO_ESCROW_PUBLIC_KEY to be configured — " +
          "there is no escrow blob to write without an escrow key.",
      );
    }
    if (config.secretsManager.type !== "VAULT") {
      throw new Error(
        "ARCHESTRA_CHAT_INCOGNITO_ESCROW_SINK=vault requires " +
          "ARCHESTRA_SECRETS_MANAGER=Vault (the escrow blob is written to " +
          "the configured HashiCorp Vault secrets backend).",
      );
    }
  }

  if (!pem) return;

  if (!config.enterpriseFeatures.core) {
    throw new Error(
      "Incognito escrow (ARCHESTRA_CHAT_INCOGNITO_ESCROW_PUBLIC_KEY) " +
        "requires an enterprise license. Unset the variable or contact " +
        "sales@archestra.ai.",
    );
  }
  // Throws with the parse/size problem named.
  loadEscrowKey(pem);
}

/**
 * Produce the escrow record for a new incognito conversation: wrap the DEK
 * to the escrow key and either return the blob for inline (db-sink) storage
 * or write it to Vault and return the reference marker. Callers must have
 * checked {@link isIncognitoEscrowConfigured} first. Fail closed: a Vault
 * write failure throws (500) so the conversation is never created without
 * its escrow copy.
 */
export async function produceIncognitoEscrow(params: {
  dek: Buffer;
  conversationId: string;
}): Promise<IncognitoEscrowBlob> {
  const wrapped = wrapIncognitoDek(params.dek);
  if (config.chatIncognito.escrowSink !== "vault") {
    return wrapped;
  }
  const path = await writeEscrowBlobToVault({
    conversationId: params.conversationId,
    blob: wrapped,
  });
  return { v: 1, sink: "vault", path };
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

/** Relative Vault folder (under the configured secret path) for escrow blobs. */
const VAULT_ESCROW_FOLDER = "incognito-escrow";

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

/**
 * Write the wrapped blob to Vault at `incognito-escrow/<conversationId>`
 * (relative to the configured secret path). Returns the full Vault path for
 * the reference marker. Write-only by design: nothing in the platform ever
 * reads this path back, so a create-only Vault policy suffices. Any failure
 * — including a non-Vault secrets backend, which the boot guard should have
 * prevented — throws a 500 BEFORE the conversation row is inserted.
 */
async function writeEscrowBlobToVault(params: {
  conversationId: string;
  blob: IncognitoEscrowWrappedDek;
}): Promise<string> {
  const manager = secretManager();
  if (manager.type !== SecretsManagerType.Vault) {
    // Boot guard enforces ARCHESTRA_SECRETS_MANAGER=Vault, but an invalid
    // Vault configuration silently falls back to the DB manager — fail the
    // creation rather than storing the blob somewhere readable.
    throw new ApiError(
      500,
      "Incognito escrow is configured with the Vault sink but the Vault " +
        "secrets backend is not active; the conversation was not created.",
    );
  }
  const vaultManager = manager as VaultSecretManager;
  try {
    return await vaultManager.writeValueAtRelativePath({
      relativePath: `${VAULT_ESCROW_FOLDER}/${params.conversationId}`,
      value: JSON.stringify(params.blob),
    });
  } catch (error) {
    logger.error(
      { error, conversationId: params.conversationId },
      "Incognito escrow Vault write failed; failing conversation creation (fail closed)",
    );
    throw new ApiError(
      500,
      "Failed to write the incognito escrow key to Vault; the conversation " +
        "was not created.",
    );
  }
}
