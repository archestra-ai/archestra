import { readFile } from "node:fs/promises";
import config from "@/config";

const ANTHROPIC_JWT_BEARER_GRANT_TYPE =
  "urn:ietf:params:oauth:grant-type:jwt-bearer";
const TOKEN_REFRESH_SKEW_MS = 120_000;

type AnthropicWorkloadIdentityConfig =
  typeof config.llm.anthropic.workloadIdentity;

type TokenCacheEntry = {
  accessToken: string;
  expiresAt: number;
};

type TokenExchangeResponse = {
  access_token?: unknown;
  expires_in?: unknown;
  token_type?: unknown;
};

const tokenCache = new Map<string, TokenCacheEntry>();

export function isAnthropicWorkloadIdentityEnabled(): boolean {
  const workloadIdentity = getWorkloadIdentityConfig();

  return (
    workloadIdentity.enabled &&
    Boolean(workloadIdentity.federationRuleId) &&
    Boolean(workloadIdentity.organizationId) &&
    Boolean(workloadIdentity.serviceAccountId) &&
    Boolean(
      workloadIdentity.identityTokenFile || workloadIdentity.identityToken,
    )
  );
}

export function getAnthropicWorkloadIdentityBearerTokenProvider(
  baseUrl?: string,
  fetchImpl?: typeof globalThis.fetch,
): () => Promise<string> {
  const tokenEndpoint = resolveTokenEndpoint(baseUrl);

  return async () =>
    getAnthropicWorkloadIdentityToken(tokenEndpoint, fetchImpl);
}

async function getAnthropicWorkloadIdentityToken(
  tokenEndpoint: string,
  fetchImpl?: typeof globalThis.fetch,
): Promise<string> {
  const workloadIdentity = getWorkloadIdentityConfig();
  const cacheKey = createCacheKey(tokenEndpoint, workloadIdentity);
  const cachedToken = tokenCache.get(cacheKey);
  if (
    cachedToken &&
    cachedToken.expiresAt - TOKEN_REFRESH_SKEW_MS > Date.now()
  ) {
    return cachedToken.accessToken;
  }

  const assertion = await resolveIdentityToken(workloadIdentity);
  const response = await exchangeIdentityToken(
    tokenEndpoint,
    assertion,
    workloadIdentity,
    fetchImpl,
  );

  tokenCache.set(cacheKey, response);
  return response.accessToken;
}

function getWorkloadIdentityConfig(): AnthropicWorkloadIdentityConfig {
  return config.llm.anthropic.workloadIdentity;
}

async function resolveIdentityToken(
  workloadIdentity: AnthropicWorkloadIdentityConfig,
): Promise<string> {
  if (workloadIdentity.identityTokenFile) {
    return (await readFile(workloadIdentity.identityTokenFile, "utf8")).trim();
  }

  if (workloadIdentity.identityToken) {
    return workloadIdentity.identityToken;
  }

  throw new Error(
    "Anthropic workload identity requires ARCHESTRA_ANTHROPIC_IDENTITY_TOKEN_FILE or ARCHESTRA_ANTHROPIC_IDENTITY_TOKEN",
  );
}

async function exchangeIdentityToken(
  tokenEndpoint: string,
  assertion: string,
  workloadIdentity: AnthropicWorkloadIdentityConfig,
  fetchImpl?: typeof globalThis.fetch,
): Promise<TokenCacheEntry> {
  const fetchFn = fetchImpl ?? globalThis.fetch;
  const body: Record<string, string> = {
    grant_type: ANTHROPIC_JWT_BEARER_GRANT_TYPE,
    assertion,
    federation_rule_id: workloadIdentity.federationRuleId,
    organization_id: workloadIdentity.organizationId,
    service_account_id: workloadIdentity.serviceAccountId,
  };

  if (workloadIdentity.workspaceId) {
    body.workspace_id = workloadIdentity.workspaceId;
  }

  const response = await fetchFn(tokenEndpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(
      `Anthropic workload identity token exchange failed with HTTP ${response.status}`,
    );
  }

  const tokenResponse = (await response.json()) as TokenExchangeResponse;
  if (typeof tokenResponse.access_token !== "string") {
    throw new Error(
      "Anthropic workload identity token exchange response did not include access_token",
    );
  }

  const expiresInSeconds =
    typeof tokenResponse.expires_in === "number" ? tokenResponse.expires_in : 0;

  return {
    accessToken: tokenResponse.access_token,
    expiresAt: Date.now() + expiresInSeconds * 1000,
  };
}

function resolveTokenEndpoint(baseUrl?: string): string {
  const resolvedBaseUrl =
    baseUrl || config.llm.anthropic.baseUrl || "https://api.anthropic.com";
  const normalizedBaseUrl = resolvedBaseUrl.endsWith("/")
    ? resolvedBaseUrl
    : `${resolvedBaseUrl}/`;

  return new URL("v1/oauth/token", normalizedBaseUrl).toString();
}

function createCacheKey(
  tokenEndpoint: string,
  workloadIdentity: AnthropicWorkloadIdentityConfig,
): string {
  return [
    tokenEndpoint,
    workloadIdentity.federationRuleId,
    workloadIdentity.organizationId,
    workloadIdentity.serviceAccountId,
    workloadIdentity.workspaceId,
    workloadIdentity.identityTokenFile,
  ].join("|");
}
