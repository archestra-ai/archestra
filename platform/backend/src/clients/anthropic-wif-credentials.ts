import { readFileSync } from "node:fs";
import config from "@/config";
import logger from "@/logging";

const ANTHROPIC_TOKEN_ENDPOINT = "/v1/oauth/token";

interface WifTokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
}

let cachedToken: { token: string; expiresAt: number } | null = null;

export function isAnthropicWifEnabled(): boolean {
  return config.llm.anthropic.wif.enabled;
}

function readIdentityToken(): string {
  const filePath = config.llm.anthropic.wif.identityTokenFile;
  if (!filePath) {
    throw new Error(
      "ARCHESTRA_ANTHROPIC_WIF_IDENTITY_TOKEN_FILE is not configured",
    );
  }
  return readFileSync(filePath, "utf-8").trim();
}

async function exchangeToken(
  baseFetch: typeof globalThis.fetch,
): Promise<WifTokenResponse> {
  const { federationRuleId, organizationId, serviceAccountId, workspaceId } =
    config.llm.anthropic.wif;
  const baseUrl = config.llm.anthropic.baseUrl;
  const identityToken = readIdentityToken();

  const response = await baseFetch(`${baseUrl}${ANTHROPIC_TOKEN_ENDPOINT}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: identityToken,
      federation_rule_id: federationRuleId,
      organization_id: organizationId,
      service_account_id: serviceAccountId,
      workspace_id: workspaceId,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `Anthropic WIF token exchange failed (${response.status}): ${body}`,
    );
  }

  return (await response.json()) as WifTokenResponse;
}

async function getAccessToken(
  baseFetch: typeof globalThis.fetch,
): Promise<string> {
  const now = Date.now();
  // Refresh 120s before expiry (advisory refresh)
  if (cachedToken && cachedToken.expiresAt - now > 120_000) {
    return cachedToken.token;
  }

  try {
    const tokenResponse = await exchangeToken(baseFetch);
    cachedToken = {
      token: tokenResponse.access_token,
      expiresAt: now + tokenResponse.expires_in * 1000,
    };
    logger.info("Anthropic WIF token exchanged successfully");
    return cachedToken.token;
  } catch (error) {
    // If we still have a valid (but soon-expiring) token, use it
    if (cachedToken && cachedToken.expiresAt - now > 30_000) {
      logger.warn("Anthropic WIF token refresh failed, using cached token", {
        error,
      });
      return cachedToken.token;
    }
    throw error;
  }
}

export function createAnthropicWifFetch(
  baseFetch: typeof globalThis.fetch | undefined,
): typeof globalThis.fetch {
  return async (input, init) => {
    const fetchFn = baseFetch ?? globalThis.fetch;
    const token = await getAccessToken(fetchFn);
    const headers = new Headers(init?.headers);
    headers.set("Authorization", `Bearer ${token}`);
    return fetchFn(input, { ...init, headers });
  };
}
