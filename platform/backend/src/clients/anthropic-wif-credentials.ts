import { readFile } from "node:fs/promises";
import config from "@/config";

/**
 * Anthropic Workload Identity Federation (WIF) support.
 *
 * Exchanges a short-lived OIDC token from an external identity provider
 * (AWS, GCP, Azure, GitHub Actions, Kubernetes, etc.) for an Anthropic
 * access token, eliminating the need for long-lived API keys.
 *
 * @see https://platform.claude.com/docs/en/manage-claude/workload-identity-federation
 */

let cachedAccessToken: string | null = null;
let tokenExpiresAt = 0;

/**
 * Check if Anthropic WIF is enabled and fully configured.
 */
export function isAnthropicWifEnabled(): boolean {
  const wif = config.llm.anthropic.workloadIdentityFederation;
  return (
    wif.enabled &&
    wif.federationRuleId !== "" &&
    wif.organizationId !== "" &&
    wif.serviceAccountId !== "" &&
    wif.workspaceId !== "" &&
    wif.identityTokenFile !== ""
  );
}

/**
 * Read the OIDC identity token from the configured file path.
 */
async function readIdentityToken(): Promise<string> {
  const tokenFile =
    config.llm.anthropic.workloadIdentityFederation.identityTokenFile;
  const token = await readFile(tokenFile, "utf-8");
  return token.trim();
}

/**
 * Exchange the OIDC identity token for a short-lived Anthropic access token.
 * Caches the token until it expires (with a 60s safety margin).
 */
async function exchangeToken(): Promise<string> {
  if (cachedAccessToken && Date.now() < tokenExpiresAt) {
    return cachedAccessToken;
  }

  const wif = config.llm.anthropic.workloadIdentityFederation;
  const identityToken = await readIdentityToken();

  const baseUrl = config.llm.anthropic.baseUrl;
  const response = await fetch(`${baseUrl}/v1/oauth/token`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: identityToken,
      federation_rule_id: wif.federationRuleId,
      organization_id: wif.organizationId,
      service_account_id: wif.serviceAccountId,
      workspace_id: wif.workspaceId,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    // Clear cached token on failure
    cachedAccessToken = null;
    tokenExpiresAt = 0;
    throw new Error(
      `Anthropic WIF token exchange failed: ${response.status} ${errorText}`,
    );
  }

  const data = (await response.json()) as {
    access_token: string;
    expires_in: number;
    token_type: string;
    scope: string;
  };

  cachedAccessToken = data.access_token;
  // Refresh 60 seconds before expiry
  tokenExpiresAt = Date.now() + (data.expires_in - 60) * 1000;

  return cachedAccessToken;
}

/**
 * Get the Anthropic WIF access token for use in API requests.
 * Returns a Bearer token suitable for the Authorization header.
 */
export async function getAnthropicWifAccessToken(): Promise<string> {
  return await exchangeToken();
}
