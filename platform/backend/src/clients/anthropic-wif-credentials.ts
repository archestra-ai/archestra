import { readFile } from "node:fs/promises";
import config from "@/config";
import logger from "@/logging";

const TOKEN_ENDPOINT = "/v1/oauth/token";
const GRANT_TYPE_JWT_BEARER = "urn:ietf:params:oauth:grant-type:jwt-bearer";

interface TokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  scope?: string;
}

let cachedToken: { token: string; expiresAt: number } | null = null;

/**
 * Whether Anthropic Workload Identity Federation is configured and enabled.
 */
export function isAnthropicWifEnabled(): boolean {
  const { wif } = config.llm.anthropic;
  return (
    wif.enabled && !!wif.federationRuleId && !!wif.organizationId
  );
}

/**
 * Reads the identity token (JWT) from the configured file path or
 * environment variable. Kubernetes projected service-account tokens,
 * GitHub Actions OIDC tokens, and similar providers write the JWT to a
 * well-known file path.
 */
async function readIdentityToken(): Promise<string> {
  const { identityTokenFile } = config.llm.anthropic.wif;

  if (identityTokenFile) {
    const token = await readFile(identityTokenFile, "utf-8");
    return token.trim();
  }

  // Fall back to the standard Anthropic SDK env var
  const envToken = process.env.ANTHROPIC_IDENTITY_TOKEN;
  if (envToken) {
    return envToken.trim();
  }

  const envTokenFile = process.env.ANTHROPIC_IDENTITY_TOKEN_FILE;
  if (envTokenFile) {
    const token = await readFile(envTokenFile, "utf-8");
    return token.trim();
  }

  throw new Error(
    "Anthropic WIF is enabled but no identity token source is configured. " +
      "Set ARCHESTRA_ANTHROPIC_WIF_IDENTITY_TOKEN_FILE, " +
      "ANTHROPIC_IDENTITY_TOKEN_FILE, or ANTHROPIC_IDENTITY_TOKEN.",
  );
}

/**
 * Exchanges an OIDC identity token for a short-lived Anthropic access token
 * via the RFC 7523 jwt-bearer grant. Caches the token until 60 seconds
 * before expiry.
 */
export async function getAnthropicWifAccessToken(): Promise<string> {
  // Return cached token if still valid (with 60s buffer)
  const now = Math.floor(Date.now() / 1000);
  if (cachedToken && cachedToken.expiresAt > now + 60) {
    return cachedToken.token;
  }

  const { federationRuleId, organizationId, serviceAccountId, workspaceId } =
    config.llm.anthropic.wif;
  const baseUrl = config.llm.anthropic.baseUrl;

  const jwt = await readIdentityToken();

  const body: Record<string, string> = {
    grant_type: GRANT_TYPE_JWT_BEARER,
    assertion: jwt,
    federation_rule_id: federationRuleId,
    organization_id: organizationId,
  };
  if (serviceAccountId) {
    body.service_account_id = serviceAccountId;
  }
  if (workspaceId) {
    body.workspace_id = workspaceId;
  }

  const url = `${baseUrl}${TOKEN_ENDPOINT}`;

  logger.debug(
    { url, federationRuleId, organizationId },
    "Exchanging OIDC JWT for Anthropic access token",
  );

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "anthropic-version": "2023-06-01",
    },
    body: new URLSearchParams(body).toString(),
  });

  if (!response.ok) {
    const errorText = await response.text();
    logger.error(
      { status: response.status, error: errorText },
      "Anthropic WIF token exchange failed",
    );
    throw new Error(
      `Anthropic WIF token exchange failed: ${response.status} ${errorText}`,
    );
  }

  const data = (await response.json()) as TokenResponse;

  cachedToken = {
    token: data.access_token,
    expiresAt: now + data.expires_in,
  };

  logger.info(
    { expiresIn: data.expires_in },
    "Anthropic WIF token exchanged successfully",
  );

  return data.access_token;
}

/**
 * Returns a bearer token provider function suitable for creating an
 * Anthropic SDK client with `authToken`.
 */
export function getAnthropicWifBearerTokenProvider(): () => Promise<string> {
  return getAnthropicWifAccessToken;
}
