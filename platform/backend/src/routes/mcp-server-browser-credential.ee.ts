// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import type { IncomingHttpHeaders } from "node:http";
import {
  CREDENTIAL_KEY_HEADER,
  credentialKeyFingerprint,
  credentialKeyMatches,
  encryptCredentialBagValues,
  isMcpBrowserCredentialsEnabled,
  parseCredentialKeyHeader,
  wrapCredentialKey,
} from "@/content-encryption/browser-credential.ee";
import { isByosEnabled, secretManager } from "@/secrets-manager";
import { ApiError, type IncognitoEscrowBlob } from "@/types";

/**
 * Request-side helpers for browser-key MCP credentials: header parsing, the
 * connect-time eligibility gate, and sealing a validated plaintext secret
 * into browser-key envelopes. All key material stays request-scoped.
 */

/** Error type surfaced on a present-but-wrong credential key (409). */
const BROWSER_CREDENTIAL_KEY_MISMATCH_TYPE = "browser_credential_key_mismatch";

/** Parse the credential-key header (null when absent; 400 when malformed). */
export function readCredentialKeyHeader(
  headers: IncomingHttpHeaders,
): Buffer | null {
  const raw = headers[CREDENTIAL_KEY_HEADER];
  const value = Array.isArray(raw) ? raw[0] : raw;
  try {
    return parseCredentialKeyHeader(value);
  } catch (error) {
    throw new ApiError(
      400,
      error instanceof Error ? error.message : "invalid credential key header",
    );
  }
}

/**
 * Connect-time eligibility gate for a browser-key-protected install. Only a
 * PERSONAL install of a REMOTE server with static, freshly submitted
 * credentials qualifies: OAuth secrets rotate server-side, enterprise-managed
 * catalogs exchange per-caller credentials, BYOS bags hold vault references,
 * and local servers receive secrets as pod material — none of which the
 * browser key can wrap. Returns the parsed key.
 */
export function requireBrowserCredentialInstallAllowed(params: {
  headers: IncomingHttpHeaders;
  catalogItem: {
    serverType: string;
    oauthConfig: unknown;
    enterpriseManagedConfig: unknown;
  } | null;
  scope: string;
  isByosVault: boolean | undefined;
  providedSecretId: string | undefined;
}): Buffer {
  if (!isMcpBrowserCredentialsEnabled()) {
    throw new ApiError(
      403,
      "Browser-key MCP credentials are not enabled on this instance. They " +
        "require an enterprise license and a configured " +
        "ARCHESTRA_MCP_CREDENTIAL_ESCROW_PUBLIC_KEY.",
    );
  }
  if (params.catalogItem?.serverType !== "remote") {
    throw new ApiError(
      400,
      "Browser-key protection is only available for remote MCP servers with " +
        "static credentials.",
    );
  }
  if (params.catalogItem.oauthConfig) {
    throw new ApiError(
      400,
      "Browser-key protection is not available for OAuth-based MCP servers — " +
        "their tokens are rotated server-side and cannot live only in the " +
        "browser.",
    );
  }
  if (params.catalogItem.enterpriseManagedConfig) {
    throw new ApiError(
      400,
      "Browser-key protection is not available for enterprise-managed MCP " +
        "servers — their credentials are exchanged per caller, not stored.",
    );
  }
  if (params.isByosVault || isByosEnabled()) {
    throw new ApiError(
      400,
      "Browser-key protection is not available when Readonly Vault (BYOS) is " +
        "enabled — vault references cannot be wrapped by a browser key.",
    );
  }
  if (params.scope !== "personal") {
    throw new ApiError(
      400,
      "Browser-key protection is only available for personal connections.",
    );
  }
  if (params.providedSecretId) {
    throw new ApiError(
      400,
      "Browser-key protection requires submitting the credential values " +
        "directly so they can be sealed; a pre-created secret cannot be used.",
    );
  }
  const key = readCredentialKeyHeader(params.headers);
  if (!key) {
    throw new ApiError(
      400,
      `Browser-key protection requires the ${CREDENTIAL_KEY_HEADER} header — ` +
        "the key is generated and held by the browser.",
    );
  }
  return key;
}

/**
 * Require and validate the credential key for an already-protected server
 * (inspector / reload-tools): 400 when absent, 409 with
 * {@link BROWSER_CREDENTIAL_KEY_MISMATCH_TYPE} when it does not match.
 */
export function requireCredentialKeyForProtectedServer(params: {
  headers: IncomingHttpHeaders;
  mcpServer: { id: string; browserKeyFingerprint: string | null };
}): Buffer {
  const key = readCredentialKeyHeader(params.headers);
  if (!key) {
    throw new ApiError(
      400,
      "This connection is protected by a browser-held key and requires the " +
        `${CREDENTIAL_KEY_HEADER} header — it can only be used from the ` +
        "owner's browser.",
    );
  }
  if (
    !params.mcpServer.browserKeyFingerprint ||
    !credentialKeyMatches({
      storedFingerprint: params.mcpServer.browserKeyFingerprint,
      mcpServerId: params.mcpServer.id,
      key,
    })
  ) {
    throw new ApiError(
      409,
      "The provided credential key does not match the browser-held key " +
        "protecting this connection.",
      BROWSER_CREDENTIAL_KEY_MISMATCH_TYPE,
    );
  }
  return key;
}

/**
 * Seal a connection-validated plaintext secret under the browser key, bound
 * to the final mcp_server id: envelope-wrap the sensitive bag values in
 * place (catalog-static shared defaults stay plaintext) and return the row
 * fields that flip the install into its protected state.
 */
export async function sealBrowserProtectedSecret(params: {
  secretId: string;
  mcpServerId: string;
  key: Buffer;
  /** Catalog-static (shared, non-secret) bag keys left unwrapped. */
  staticValueKeys: ReadonlySet<string>;
}): Promise<{
  browserKeyProtected: true;
  browserKeyFingerprint: string;
  browserKeyEscrow: IncognitoEscrowBlob;
}> {
  const record = await secretManager().getSecret(params.secretId);
  const sealed = encryptCredentialBagValues(record?.secret ?? {}, {
    key: params.key,
    mcpServerId: params.mcpServerId,
    skipKeys: params.staticValueKeys,
  });
  await secretManager().updateSecret(params.secretId, sealed);
  return {
    browserKeyProtected: true,
    browserKeyFingerprint: credentialKeyFingerprint(
      params.mcpServerId,
      params.key,
    ),
    browserKeyEscrow: wrapCredentialKey(params.key),
  };
}
