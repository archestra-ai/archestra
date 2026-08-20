import {
  createHash,
  createPublicKey,
  constants as cryptoConstants,
  type KeyObject,
  publicEncrypt,
} from "node:crypto";
import config from "@/config";
import type { LockedChatEscrowBlob } from "@/types";

/**
 * Key escrow for locked chats: at conversation creation the browser-held
 * DEK is wrapped to an operator-configured RSA public key
 * (ARCHESTRA_LOCKED_CHAT_ESCROW_PUBLIC_KEY) whose private half is held
 * offline by the customer's security team. Recovering content is an explicit
 * break-glass procedure, not something the platform can do alone.
 *
 * Escrow is what ENABLES locked chats: without it, a conversation's audit
 * trail (LLM interactions, MCP tool calls, chat errors, tool-execution claims,
 * replay payloads) would be encrypted under a key no one but that one browser
 * holds, which is unrecoverable rather than merely private — the opposite of
 * what an auditable deployment needs. So locked-chat is unavailable until an
 * escrow key is configured.
 *
 * The wrapped key is stored inline on the conversation row. That is safe by
 * construction rather than by access control: unwrapping needs the offline
 * private half, so a database dump yields ciphertext under two separate keys
 * and opens neither. There is deliberately no choice of where it goes — a
 * second location would guard only against compromise of the offline private
 * key, at the cost of a store the platform cannot read back to verify.
 */

/**
 * True when a usable escrow key is configured. This is the locked-chat
 * enablement gate — see {@link isLockedChatEnabled}.
 */
export function isLockedChatEscrowConfigured(): boolean {
  return escrowKeyOrNull() !== null;
}

/**
 * Boot-time validation, mirroring the content-encryption guard's posture: an
 * operator who configured escrow must never silently run with it ignored
 * because of a bad PEM or an undersized key.
 */
export function verifyLockedChatConfig(): void {
  const pem = config.lockedChat.escrowPublicKey;
  if (!pem) return;
  // Throws with the parse/size problem named.
  loadEscrowKey(pem);
}

/**
 * Wrap a DEK to the escrow public key. RSA-OAEP with an EXPLICIT sha256 —
 * Node's default OAEP hash is SHA-1. The blob is versioned so the offline
 * recovery procedure is unambiguous.
 * @public — exported so tests can pin the exact offline recovery contract
 */
export function wrapLockedChatDek(dek: Buffer): LockedChatEscrowBlob {
  const key = escrowKeyOrNull();
  if (!key) {
    throw new Error(
      "locked chat escrow public key is not configured — this is a bug in the " +
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

/**
 * Parses the configured PEM once and re-parses only when it changes. Keyed on
 * the PEM itself rather than a boolean, so a config change (or a test mutating
 * the value between cases) is picked up instead of serving a stale key.
 */
class EscrowKeyCache {
  private key: KeyObject | null = null;
  private pem: string | null = null;

  resolve(): KeyObject | null {
    const pem = config.lockedChat.escrowPublicKey;
    if (!pem) return null;
    if (this.key && this.pem === pem) return this.key;
    try {
      this.key = loadEscrowKey(pem);
      this.pem = pem;
      return this.key;
    } catch {
      // Invalid key: the boot guard rejects this at startup; treat escrow
      // as unconfigured rather than half-working if it is somehow reached.
      return null;
    }
  }
}

const escrowKeyCache = new EscrowKeyCache();

function escrowKeyOrNull(): KeyObject | null {
  return escrowKeyCache.resolve();
}

function loadEscrowKey(pem: string): KeyObject {
  // Tolerate env-var PEMs with literal "\n" sequences.
  const normalized = pem.includes("-----")
    ? pem.replace(/\\n/g, "\n")
    : Buffer.from(pem, "base64").toString("utf8");
  const key = createPublicKey(normalized);
  if (key.asymmetricKeyType !== "rsa") {
    throw new Error(
      "ARCHESTRA_LOCKED_CHAT_ESCROW_PUBLIC_KEY must be an RSA public key " +
        `(got ${key.asymmetricKeyType})`,
    );
  }
  const modulusBits = key.asymmetricKeyDetails?.modulusLength ?? 0;
  if (modulusBits < MIN_ESCROW_MODULUS_BITS) {
    throw new Error(
      `ARCHESTRA_LOCKED_CHAT_ESCROW_PUBLIC_KEY must be at least ` +
        `${MIN_ESCROW_MODULUS_BITS} bits (got ${modulusBits})`,
    );
  }
  return key;
}

function escrowKeyFingerprint(key: KeyObject): string {
  const der = key.export({ type: "spki", format: "der" });
  return createHash("sha256").update(der).digest("hex").slice(0, 16);
}
