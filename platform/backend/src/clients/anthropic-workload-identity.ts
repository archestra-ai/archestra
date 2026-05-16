import { readFile } from "node:fs/promises";

const JWT_BEARER_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:jwt-bearer";
const ADVISORY_REFRESH_MS = 120_000;
const MANDATORY_REFRESH_MS = 30_000;

type FetchLike = typeof fetch;

interface AnthropicWorkloadIdentityConfig {
  federationRuleId: string;
  organizationId: string;
  serviceAccountId: string;
  workspaceId?: string;
  identityToken?: string;
  identityTokenFile?: string;
}

interface TokenCacheEntry {
  accessToken: string;
  expiresAtMs: number;
}

interface TokenExchangeResponse {
  access_token?: unknown;
  token_type?: unknown;
  expires_in?: unknown;
  scope?: unknown;
}

let cachedToken: TokenCacheEntry | null = null;

export function isAnthropicWorkloadIdentityConfigured(): boolean {
  return getAnthropicWorkloadIdentityConfig() !== null;
}

export function hasAnthropicSdkStaticCredentialsConfigured(): boolean {
  return (
    readOptionalEnv("ANTHROPIC_API_KEY") !== undefined ||
    readOptionalEnv("ANTHROPIC_AUTH_TOKEN") !== undefined
  );
}

export function resetAnthropicWorkloadIdentityTokenCacheForTests(): void {
  cachedToken = null;
}

export function createAnthropicWorkloadIdentityFetch(
  baseFetch: FetchLike | undefined,
  baseUrl: string | undefined,
): FetchLike {
  const fetchFn = baseFetch ?? fetch;

  return (async (input, init) => {
    const token = await getAnthropicWorkloadIdentityAccessToken(baseUrl);
    const headers = buildHeaders(input, init);
    headers.delete("x-api-key");
    headers.set("authorization", `Bearer ${token}`);

    return fetchFn(input, {
      ...init,
      headers,
    });
  }) as FetchLike;
}

export async function getAnthropicWorkloadIdentityAccessToken(
  baseUrl: string | undefined,
): Promise<string> {
  const now = Date.now();
  if (cachedToken && now < cachedToken.expiresAtMs - ADVISORY_REFRESH_MS) {
    return cachedToken.accessToken;
  }

  try {
    cachedToken = await exchangeAnthropicWorkloadIdentityToken(baseUrl);
    return cachedToken.accessToken;
  } catch (error) {
    if (cachedToken && now < cachedToken.expiresAtMs - MANDATORY_REFRESH_MS) {
      return cachedToken.accessToken;
    }
    throw error;
  }
}

async function exchangeAnthropicWorkloadIdentityToken(
  baseUrl: string | undefined,
): Promise<TokenCacheEntry> {
  const config = getAnthropicWorkloadIdentityConfig();
  if (!config) {
    throw new Error(
      "Anthropic Workload Identity Federation is not configured. Set ARCHESTRA_ANTHROPIC_FEDERATION_RULE_ID, ARCHESTRA_ANTHROPIC_ORGANIZATION_ID, ARCHESTRA_ANTHROPIC_SERVICE_ACCOUNT_ID, and ARCHESTRA_ANTHROPIC_IDENTITY_TOKEN_FILE or ARCHESTRA_ANTHROPIC_IDENTITY_TOKEN.",
    );
  }

  const assertion = await readIdentityToken(config);
  const body: Record<string, string> = {
    grant_type: JWT_BEARER_GRANT_TYPE,
    assertion,
    federation_rule_id: config.federationRuleId,
    organization_id: config.organizationId,
    service_account_id: config.serviceAccountId,
  };

  if (config.workspaceId) {
    body.workspace_id = config.workspaceId;
  }

  const response = await fetch(`${normalizeBaseUrl(baseUrl)}/v1/oauth/token`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const requestId = response.headers.get("request-id");
    throw new Error(
      `Anthropic Workload Identity Federation token exchange failed with status ${response.status}${requestId ? ` (request-id: ${requestId})` : ""}`,
    );
  }

  const data = (await response.json()) as TokenExchangeResponse;
  if (
    typeof data.access_token !== "string" ||
    data.access_token.length === 0 ||
    data.token_type !== "Bearer" ||
    typeof data.expires_in !== "number" ||
    !Number.isFinite(data.expires_in) ||
    data.expires_in <= 0
  ) {
    throw new Error(
      "Anthropic Workload Identity Federation token exchange returned an invalid token response.",
    );
  }

  return {
    accessToken: data.access_token,
    expiresAtMs: Date.now() + data.expires_in * 1000,
  };
}

function getAnthropicWorkloadIdentityConfig(): AnthropicWorkloadIdentityConfig | null {
  const federationRuleId = readRequiredEnv(
    "ARCHESTRA_ANTHROPIC_FEDERATION_RULE_ID",
  );
  const organizationId = readRequiredEnv("ARCHESTRA_ANTHROPIC_ORGANIZATION_ID");
  const serviceAccountId = readRequiredEnv(
    "ARCHESTRA_ANTHROPIC_SERVICE_ACCOUNT_ID",
  );
  const identityTokenFile = readOptionalEnv(
    "ARCHESTRA_ANTHROPIC_IDENTITY_TOKEN_FILE",
  );
  const identityToken = readOptionalEnv("ARCHESTRA_ANTHROPIC_IDENTITY_TOKEN");

  if (
    !federationRuleId ||
    !organizationId ||
    !serviceAccountId ||
    (!identityTokenFile && !identityToken)
  ) {
    return null;
  }

  return {
    federationRuleId,
    organizationId,
    serviceAccountId,
    workspaceId: readOptionalEnv("ARCHESTRA_ANTHROPIC_WORKSPACE_ID"),
    identityToken,
    identityTokenFile,
  };
}

async function readIdentityToken(
  config: AnthropicWorkloadIdentityConfig,
): Promise<string> {
  if (config.identityToken) {
    return config.identityToken;
  }

  if (!config.identityTokenFile) {
    throw new Error(
      "Anthropic Workload Identity Federation requires ARCHESTRA_ANTHROPIC_IDENTITY_TOKEN_FILE or ARCHESTRA_ANTHROPIC_IDENTITY_TOKEN.",
    );
  }

  return (await readFile(config.identityTokenFile, "utf8")).trim();
}

function readRequiredEnv(name: string): string | null {
  const value = process.env[name];
  return value && value.length > 0 ? value : null;
}

function readOptionalEnv(name: string): string | undefined {
  const value = process.env[name];
  return value && value.length > 0 ? value : undefined;
}

function normalizeBaseUrl(baseUrl: string | undefined): string {
  return (baseUrl || "https://api.anthropic.com").replace(/\/+$/, "");
}

function buildHeaders(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
): Headers {
  const headers = new Headers(
    input instanceof Request ? input.headers : undefined,
  );
  const initHeaders = new Headers(init?.headers);
  for (const [key, value] of initHeaders.entries()) {
    headers.set(key, value);
  }
  return headers;
}
