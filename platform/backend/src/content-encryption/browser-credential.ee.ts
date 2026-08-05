// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import type { KeyObject } from "node:crypto";
import config from "@/config";
import type { IncognitoEscrowWrappedDek } from "@/types/conversation";
import { decryptStringWithKey, encryptStringWithKey } from "@/utils/crypto";
import {
  browserKeyFingerprint,
  browserKeyMatches,
  parseBrowserKeyHeader,
} from "./browser-key";
import { loadEscrowPublicKey, wrapBrowserKey } from "./browser-key.ee";
import { isContentEnvelope } from "./index.ee";

/**
 * Browser-key MCP credentials (enterprise): a personal static credential
 * (API key / PAT) on a REMOTE MCP server can be protected by a key that
 * lives only in the user's browser. The sensitive credential values are
 * AES-256-GCM envelopes under that key inside the stored secret bag; the
 * gateway unwraps them transiently — per request, never cached — to build
 * the outbound Authorization/custom headers. Without the browser present
 * the connection is "browser-locked": schedules, ChatOps, external API
 * clients, and other users get a typed refusal, never a fall-through to a
 * different credential.
 *
 * The user's single per-browser key wraps every credential they protect
 * (transport simplicity across tool batches and multi-replica retries); a
 * compromise of that one key therefore exposes all of that user's protected
 * credentials — documented, and recovery from key loss is re-authenticating
 * each connection. Escrow: the key is wrapped RSA-OAEP-256 to
 * ARCHESTRA_MCP_CREDENTIAL_ESCROW_PUBLIC_KEY per protected server for
 * break-glass recovery by the operator's security team.
 */

/** Request header carrying the base64url-encoded 32-byte credential key. */
export const CREDENTIAL_KEY_HEADER = "x-archestra-credential-key";

/** True when the feature can be offered: EE license + valid escrow key. */
export function isMcpBrowserCredentialsEnabled(): boolean {
  return Boolean(config.enterpriseFeatures.core && escrowKeyOrNull());
}

/** Boot guard: configured-but-unusable must fail startup, never run ignored. */
export function verifyMcpBrowserCredentialConfig(): void {
  const pem = config.mcpBrowserCredentials.escrowPublicKey;
  if (!pem) return;
  if (!config.enterpriseFeatures.core) {
    throw new Error(
      "Browser-key MCP credentials " +
        "(ARCHESTRA_MCP_CREDENTIAL_ESCROW_PUBLIC_KEY) require an enterprise " +
        "license. Unset the variable or contact sales@archestra.ai.",
    );
  }
  loadEscrowPublicKey({ pem, envVarName: ESCROW_ENV_VAR });
}

/** Parse the credential-key header (null when absent; throws on malformed). */
export function parseCredentialKeyHeader(
  headerValue: string | undefined,
): Buffer | null {
  return parseBrowserKeyHeader(headerValue);
}

/** Fingerprint of the browser key bound to one protected MCP server row. */
export function credentialKeyFingerprint(
  mcpServerId: string,
  key: Buffer,
): string {
  return browserKeyFingerprint({
    domain: CREDENTIAL_FP_DOMAIN,
    subjectId: mcpServerId,
    key,
  });
}

/** Constant-time check of a presented key against a server's fingerprint. */
export function credentialKeyMatches(params: {
  storedFingerprint: string;
  mcpServerId: string;
  key: Buffer;
}): boolean {
  return browserKeyMatches({
    storedFingerprint: params.storedFingerprint,
    domain: CREDENTIAL_FP_DOMAIN,
    subjectId: params.mcpServerId,
    key: params.key,
  });
}

/** Escrow-wrap the browser key for one protected server (break-glass copy). */
export function wrapCredentialKey(key: Buffer): IncognitoEscrowWrappedDek {
  const escrowKey = escrowKeyOrNull();
  if (!escrowKey) {
    throw new Error(
      "MCP credential escrow public key is not configured — this is a bug " +
        "in the enablement gating",
    );
  }
  return wrapBrowserKey({ key, escrowKey });
}

/**
 * Encrypt one sensitive credential value under the browser key. The AAD
 * binds the ciphertext to the secret column AND the owning MCP server, so
 * an envelope cannot be transplanted between installs sharing a key.
 * @public — contract-tested directly (production paths go through
 * encryptCredentialBagValues)
 */
export function encryptCredentialValue(
  value: string,
  params: { key: Buffer; mcpServerId: string },
): { __encrypted: string } {
  return {
    __encrypted: encryptStringWithKey(
      JSON.stringify({ v: value }),
      params.key,
      credentialAad(params.mcpServerId),
    ),
  };
}

/**
 * Decrypt a stored credential value with the browser key. Plain strings
 * pass through (non-protected values in a mixed bag); an envelope the key
 * cannot open throws.
 * @public — contract-tested directly (production paths go through
 * decryptCredentialBag)
 */
export function decryptCredentialValue(
  stored: unknown,
  params: { key: Buffer; mcpServerId: string },
): string {
  if (typeof stored === "string") return stored;
  if (!isContentEnvelope(stored)) {
    throw new Error(
      "browser-key credential value is neither a string nor an envelope",
    );
  }
  const decrypted = decryptStringWithKey(
    stored.__encrypted,
    params.key,
    credentialAad(params.mcpServerId),
  );
  return (JSON.parse(decrypted) as { v: string }).v;
}

/**
 * True when a stored secret-bag value is a browser-key envelope.
 * @public — contract-tested directly; asserts the at-rest envelope shape
 */
export function isCredentialEnvelope(value: unknown): boolean {
  return isContentEnvelope(value);
}

/**
 * A browser-key-protected connection was reached without its key: schedules,
 * tokens, other users, or the owner's keyless surfaces. Terminal by design —
 * resolution must surface this refusal, never fall through to a different
 * credential.
 */
export class BrowserLockedCredentialError extends Error {
  constructor(serverName: string) {
    super(
      `The connection to "${serverName}" is protected by a browser-held key ` +
        "and can only be used from the owner's browser. Open this from the " +
        "browser that connected it, or re-authenticate the connection to " +
        "replace the credential.",
    );
    this.name = "BrowserLockedCredentialError";
  }
}

/** A key was presented but does not match the server's stored fingerprint. */
export class BrowserCredentialKeyMismatchError extends Error {
  constructor(serverName: string) {
    super(
      `The provided credential key does not match the browser-held key ` +
        `protecting the connection to "${serverName}". Use the browser that ` +
        "connected it, or re-authenticate the connection from this browser.",
    );
    this.name = "BrowserCredentialKeyMismatchError";
  }
}

/**
 * Central unlock for a browser-key-protected install's secret bag. No key →
 * {@link BrowserLockedCredentialError}; wrong key →
 * {@link BrowserCredentialKeyMismatchError}; valid key → a transient bag with
 * every envelope value decrypted (plain strings pass through). The returned
 * bag is plaintext and must NEVER be cached or persisted.
 */
export function unlockCredentialBag(params: {
  server: { id: string; name: string; browserKeyFingerprint: string | null };
  secrets: Record<string, unknown>;
  key: Buffer | null | undefined;
}): Record<string, unknown> {
  const { server, secrets, key } = params;
  if (!key) {
    throw new BrowserLockedCredentialError(server.name);
  }
  if (
    !server.browserKeyFingerprint ||
    !credentialKeyMatches({
      storedFingerprint: server.browserKeyFingerprint,
      mcpServerId: server.id,
      key,
    })
  ) {
    throw new BrowserCredentialKeyMismatchError(server.name);
  }
  try {
    return decryptCredentialBag(secrets, { key, mcpServerId: server.id });
  } catch {
    // Fingerprint matched but an envelope refused the key (e.g. a value
    // transplanted from another server). Same terminal state as a wrong key.
    throw new BrowserCredentialKeyMismatchError(server.name);
  }
}

/** Decrypt every envelope value of a secret bag (plain values pass through). */
export function decryptCredentialBag(
  secrets: Record<string, unknown>,
  params: { key: Buffer; mcpServerId: string },
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(secrets).map(([name, value]) => [
      name,
      isContentEnvelope(value) || typeof value === "string"
        ? decryptCredentialValue(value, params)
        : value,
    ]),
  );
}

/**
 * Envelope-wrap a secret bag's sensitive string values under the browser key.
 * `skipKeys` names the catalog-static (shared, non-secret) values that stay
 * plaintext; everything else the transport would send as a credential header
 * — prompted userConfig values and `access_token` alike — is wrapped.
 */
export function encryptCredentialBagValues(
  secrets: Record<string, unknown>,
  params: { key: Buffer; mcpServerId: string; skipKeys?: ReadonlySet<string> },
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(secrets).map(([name, value]) => [
      name,
      typeof value === "string" && !params.skipKeys?.has(name)
        ? encryptCredentialValue(value, {
            key: params.key,
            mcpServerId: params.mcpServerId,
          })
        : value,
    ]),
  );
}

// === Internal ===

const ESCROW_ENV_VAR = "ARCHESTRA_MCP_CREDENTIAL_ESCROW_PUBLIC_KEY";
const CREDENTIAL_FP_DOMAIN = "archestra-browser-cred-fp-v1";

let cachedEscrowKey: KeyObject | null = null;
let cachedEscrowKeyPem: string | null = null;

function credentialAad(mcpServerId: string): string {
  return `secret.secret|browser-cred:${mcpServerId}`;
}

function escrowKeyOrNull(): KeyObject | null {
  const pem = config.mcpBrowserCredentials.escrowPublicKey;
  if (!pem) return null;
  if (cachedEscrowKey && cachedEscrowKeyPem === pem) return cachedEscrowKey;
  try {
    cachedEscrowKey = loadEscrowPublicKey({ pem, envVarName: ESCROW_ENV_VAR });
    cachedEscrowKeyPem = pem;
    return cachedEscrowKey;
  } catch {
    // The boot guard rejects invalid keys at startup; disabled if reached.
    return null;
  }
}
