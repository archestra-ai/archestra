import { readFileSync } from "node:fs";
import config from "@/config";
import logger from "@/logging";

const ANTHROPIC_OAUTH_TOKEN_PATH = "/v1/oauth/token";
const REFRESH_EARLY_MS = 120_000;
const MIN_FALLBACK_TOKEN_TTL_MS = 30_000;

interface AnthropicWifTokenResponse {
  access_token: string;
  expires_in: number;
  token_type: string;
}

let cachedToken: {
  accessToken: string;
  expiresAtMs: number;
} | null = null;

export function isAnthropicWifEnabled(): boolean {
  return config.llm.anthropic.wif.enabled;
}

function assertWifConfig(): void {
  const {
    federationRuleId,
    identityTokenFile,
    organizationId,
    serviceAccountId,
    workspaceId,
  } = config.llm.anthropic.wif;

  if (!federationRuleId) {
    throw new Error(
      "ARCHESTRA_ANTHROPIC_WIF_FEDERATION_RULE_ID is not configured",
    );
  }
  if (!organizationId) {
    throw new Error(
      "ARCHESTRA_ANTHROPIC_WIF_ORGANIZATION_ID is not configured",
    );
  }
  if (!serviceAccountId) {
    throw new Error(
      "ARCHESTRA_ANTHROPIC_WIF_SERVICE_ACCOUNT_ID is not configured",
    );
  }
  if (!workspaceId) {
    throw new Error("ARCHESTRA_ANTHROPIC_WIF_WORKSPACE_ID is not configured");
  }
  if (!identityTokenFile) {
    throw new Error(
      "ARCHESTRA_ANTHROPIC_WIF_IDENTITY_TOKEN_FILE is not configured",
    );
  }
}

function readIdentityTokenFromFile(): string {
  const filePath = config.llm.anthropic.wif.identityTokenFile;
  return readFileSync(filePath, "utf-8").trim();
}

async function exchangeAnthropicWifToken(
  fetchFn: typeof globalThis.fetch,
): Promise<AnthropicWifTokenResponse> {
  assertWifConfig();

  const { federationRuleId, organizationId, serviceAccountId, workspaceId } =
    config.llm.anthropic.wif;

  const response = await fetchFn(
    `${config.llm.anthropic.baseUrl}${ANTHROPIC_OAUTH_TOKEN_PATH}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion: readIdentityTokenFromFile(),
        federation_rule_id: federationRuleId,
        organization_id: organizationId,
        service_account_id: serviceAccountId,
        workspace_id: workspaceId,
      }),
    },
  );

  if (!response.ok) {
    const responseText = await response.text();
    throw new Error(
      `Anthropic WIF token exchange failed (${response.status}): ${responseText}`,
    );
  }

  return (await response.json()) as AnthropicWifTokenResponse;
}

export async function getAnthropicWifAccessToken(
  baseFetch?: typeof globalThis.fetch,
): Promise<string> {
  const now = Date.now();
  if (cachedToken && cachedToken.expiresAtMs - now > REFRESH_EARLY_MS) {
    return cachedToken.accessToken;
  }

  const fetchFn = baseFetch ?? globalThis.fetch;

  try {
    const tokenResponse = await exchangeAnthropicWifToken(fetchFn);
    cachedToken = {
      accessToken: tokenResponse.access_token,
      expiresAtMs: now + tokenResponse.expires_in * 1000,
    };
    return cachedToken.accessToken;
  } catch (error) {
    if (
      cachedToken &&
      cachedToken.expiresAtMs - now > MIN_FALLBACK_TOKEN_TTL_MS
    ) {
      logger.warn(
        {
          errorMessage: error instanceof Error ? error.message : String(error),
        },
        "Anthropic WIF token refresh failed, falling back to cached token",
      );
      return cachedToken.accessToken;
    }
    throw error;
  }
}

export function createAnthropicWifFetch(
  baseFetch?: typeof globalThis.fetch,
): typeof globalThis.fetch {
  return async (input, init) => {
    const fetchFn = baseFetch ?? globalThis.fetch;
    const headers = new Headers(init?.headers);
    headers.set(
      "Authorization",
      `Bearer ${await getAnthropicWifAccessToken(fetchFn)}`,
    );
    return fetchFn(input, {
      ...init,
      headers,
    });
  };
}
