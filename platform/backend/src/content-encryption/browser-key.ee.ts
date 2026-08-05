// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import {
  createHash,
  createPublicKey,
  constants as cryptoConstants,
  type KeyObject,
  publicEncrypt,
} from "node:crypto";
import type { IncognitoEscrowWrappedDek } from "@/types/conversation";

/**
 * Enterprise escrow half of the browser-key primitives (base half in
 * browser-key.ts): wrapping a browser-held key to an operator-configured
 * RSA public key for break-glass recovery. Consumed by incognito-chat
 * escrow (incognito-escrow.ee.ts) and browser-key MCP credentials
 * (browser-credential.ee.ts) — each with its own env var and blob storage.
 */

/**
 * Wrap a browser key to an escrow public key. RSA-OAEP with an EXPLICIT
 * sha256 — Node's default OAEP hash is SHA-1. Versioned so offline recovery
 * tooling is unambiguous.
 */
export function wrapBrowserKey(params: {
  key: Buffer;
  escrowKey: KeyObject;
}): IncognitoEscrowWrappedDek {
  const wrapped = publicEncrypt(
    {
      key: params.escrowKey,
      padding: cryptoConstants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: "sha256",
    },
    params.key,
  );
  return {
    v: 1,
    alg: "RSA-OAEP-256",
    escrowKeyFingerprint: escrowPublicKeyFingerprint(params.escrowKey),
    wrappedDek: wrapped.toString("base64"),
  };
}

/**
 * Parse and validate an escrow public key from an env var: PEM (with literal
 * "\n" tolerated) or base64-of-PEM; RSA only, minimum modulus enforced.
 * `envVarName` appears in error messages so the operator knows which feature
 * is misconfigured.
 */
export function loadEscrowPublicKey(params: {
  pem: string;
  envVarName: string;
}): KeyObject {
  const normalized = params.pem.includes("-----")
    ? params.pem.replace(/\\n/g, "\n")
    : Buffer.from(params.pem, "base64").toString("utf8");
  const key = createPublicKey(normalized);
  if (key.asymmetricKeyType !== "rsa") {
    throw new Error(
      `${params.envVarName} must be an RSA public key ` +
        `(got ${key.asymmetricKeyType})`,
    );
  }
  const modulusBits = key.asymmetricKeyDetails?.modulusLength ?? 0;
  if (modulusBits < MIN_ESCROW_MODULUS_BITS) {
    throw new Error(
      `${params.envVarName} must be at least ` +
        `${MIN_ESCROW_MODULUS_BITS} bits (got ${modulusBits})`,
    );
  }
  return key;
}

// === Internal ===

const MIN_ESCROW_MODULUS_BITS = 2048;

/** Short identifier of an escrow public key (sha256 over the SPKI DER). */
function escrowPublicKeyFingerprint(key: KeyObject): string {
  const der = key.export({ type: "spki", format: "der" });
  return createHash("sha256").update(der).digest("hex").slice(0, 16);
}
