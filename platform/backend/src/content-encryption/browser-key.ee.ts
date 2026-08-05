// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import {
  createHash,
  createPublicKey,
  constants as cryptoConstants,
  type KeyObject,
  publicEncrypt,
  timingSafeEqual,
} from "node:crypto";
import type { IncognitoEscrowBlob } from "@/types/conversation";

/**
 * Shared primitives for browser-held keys: features where a 32-byte key
 * lives only in the user's browser, rides requests as a header, and is
 * escrowed to an operator-configured RSA public key for break-glass
 * recovery. Consumed by incognito chats (incognito.ee.ts) and browser-key
 * MCP credentials (browser-credential.ee.ts) — each with its own env var,
 * fingerprint domain, and AAD scheme.
 */

export const BROWSER_KEY_LENGTH_BYTES = 32;

/**
 * Parse a browser-key header value. Returns null when absent; throws when
 * present but malformed (not base64url, wrong length) so routes can 400
 * with a precise message instead of failing GCM later.
 */
export function parseBrowserKeyHeader(
  headerValue: string | undefined,
): Buffer | null {
  if (headerValue === undefined || headerValue === "") return null;
  let key: Buffer;
  try {
    key = Buffer.from(headerValue, "base64url");
  } catch {
    throw new Error("browser key header is not valid base64url");
  }
  if (key.length !== BROWSER_KEY_LENGTH_BYTES) {
    throw new Error(
      `browser key must decode to exactly ${BROWSER_KEY_LENGTH_BYTES} bytes`,
    );
  }
  return key;
}

/**
 * Domain-separated fingerprint of a browser key bound to a subject id
 * (conversation, MCP server). Stored on the row so a wrong key is rejected
 * up front with a clean error instead of scattered GCM failures.
 */
export function browserKeyFingerprint(params: {
  domain: string;
  subjectId: string;
  key: Buffer;
}): string {
  return createHash("sha256")
    .update(params.domain)
    .update(params.subjectId)
    .update(params.key)
    .digest("hex");
}

/** Constant-time comparison of a stored fingerprint against a presented key. */
export function browserKeyMatches(params: {
  storedFingerprint: string;
  domain: string;
  subjectId: string;
  key: Buffer;
}): boolean {
  const presented = Buffer.from(
    browserKeyFingerprint({
      domain: params.domain,
      subjectId: params.subjectId,
      key: params.key,
    }),
    "hex",
  );
  const stored = Buffer.from(params.storedFingerprint, "hex");
  return (
    stored.length === presented.length && timingSafeEqual(stored, presented)
  );
}

/**
 * Wrap a browser key to an escrow public key. RSA-OAEP with an EXPLICIT
 * sha256 — Node's default OAEP hash is SHA-1. Versioned so offline recovery
 * tooling is unambiguous.
 */
export function wrapBrowserKey(params: {
  key: Buffer;
  escrowKey: KeyObject;
}): IncognitoEscrowBlob {
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

/** Short identifier of an escrow public key (sha256 over the SPKI DER). */
export function escrowPublicKeyFingerprint(key: KeyObject): string {
  const der = key.export({ type: "spki", format: "der" });
  return createHash("sha256").update(der).digest("hex").slice(0, 16);
}

// === Internal ===

const MIN_ESCROW_MODULUS_BITS = 2048;
