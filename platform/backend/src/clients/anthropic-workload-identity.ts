import fs from "node:fs/promises";

const GRANT_TYPE_JWT_BEARER = "urn:ietf:params:oauth:grant-type:jwt-bearer";
const TOKEN_ENDPOINT = "/v1/oauth/token";
const OAUTH_API_BETA_HEADER = "oauth-2025-04-20";
const FEDERATION_BETA_HEADER = "oidc-federation-2026-04-01";
const ADVISORY_REFRESH_THRESHOLD_SECONDS = 120;
const MAX_IDENTITY_TOKEN_BYTES = 16 * 1024;

type Fetch = typeof globalThis.fetch;

type AnthropicWorkloadIdentityConfig = {
  federationRuleId: string;
  organizationId: string;
  serviceAccountId: string;
  workspaceId?: string;
  identityToken?: string;
  identityTokenFile?: string;
};

type CachedToken = {
  token: string;
  expiresAtMs: number;
};

const tokenCaches = new Map<string, Promise<CachedToken> | CachedToken>();

export function isAnthropicWorkloadIdentityEnabled(): boolean {
  const config = getAnthropicWorkloadIdentityConfig();
  return Boolean(
    config.federationRuleId &&
      config.organizationId &&
      config.serviceAccountId &&
      (config.identityToken || config.identityTokenFile),
  );
}

export async function getAnthropicWorkloadIdentityAuthHeaders(
  baseUrl: string | undefined,
): Promise<Record<string, string>> {
  return {
    Authorization: `Bearer ${await getAnthropicWorkloadIdentityToken(
      baseUrl || "https://api.anthropic.com",
    )}`,
    "anthropic-beta": OAUTH_API_BETA_HEADER,
  };
}

export function createAnthropicWorkloadIdentityFetch(
  baseUrl: string | undefined,
  upstreamFetch?: Fetch,
): Fetch {
  const resolvedBaseUrl = baseUrl || "https://api.anthropic.com";
  const fetchForUpstream = upstreamFetch ?? globalThis.fetch.bind(globalThis);

  return async (input, init = {}) => {
    const token = await getAnthropicWorkloadIdentityToken(resolvedBaseUrl);
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${token}`);
    appendAnthropicBeta(headers, OAUTH_API_BETA_HEADER);

    return fetchForUpstream(input, {
      ...init,
      headers,
    });
  };
}

function getAnthropicWorkloadIdentityConfig(): AnthropicWorkloadIdentityConfig {
  const identityToken = process.env.ARCHESTRA_ANTHROPIC_IDENTITY_TOKEN?.trim();
  const identityTokenFile =
    process.env.ARCHESTRA_ANTHROPIC_IDENTITY_TOKEN_FILE?.trim();
  return {
    federationRuleId:
      process.env.ARCHESTRA_ANTHROPIC_FEDERATION_RULE_ID?.trim() ?? "",
    organizationId:
      process.env.ARCHESTRA_ANTHROPIC_ORGANIZATION_ID?.trim() ?? "",
    serviceAccountId:
      process.env.ARCHESTRA_ANTHROPIC_SERVICE_ACCOUNT_ID?.trim() ?? "",
    workspaceId:
      process.env.ARCHESTRA_ANTHROPIC_WORKSPACE_ID?.trim() || undefined,
    identityToken: identityToken || undefined,
    identityTokenFile: identityTokenFile || undefined,
  };
}

async function getAnthropicWorkloadIdentityToken(
  baseUrl: string,
): Promise<string> {
  const config = getAnthropicWorkloadIdentityConfig();
  const cacheKey = JSON.stringify({
    baseUrl,
    federationRuleId: config.federationRuleId,
    organizationId: config.organizationId,
    serviceAccountId: config.serviceAccountId,
    workspaceId: config.workspaceId,
    identityTokenFile: config.identityTokenFile,
    hasInlineToken: Boolean(config.identityToken),
  });

  const cached = tokenCaches.get(cacheKey);
  if (cached) {
    const token = cached instanceof Promise ? await cached : cached;
    if (
      token.expiresAtMs - Date.now() >
      ADVISORY_REFRESH_THRESHOLD_SECONDS * 1000
    ) {
      return token.token;
    }
  }

  const pending = exchangeAnthropicWorkloadIdentityToken(baseUrl, config);
  tokenCaches.set(cacheKey, pending);

  try {
    const token = await pending;
    tokenCaches.set(cacheKey, token);
    return token.token;
  } catch (error) {
    tokenCaches.delete(cacheKey);
    throw error;
  }
}

async function exchangeAnthropicWorkloadIdentityToken(
  baseUrl: string,
  config: AnthropicWorkloadIdentityConfig,
): Promise<CachedToken> {
  assertWorkloadIdentityConfig(config);
  requireSecureTokenEndpoint(baseUrl);

  const assertion = await readIdentityToken(config);
  if (Buffer.byteLength(assertion, "utf8") > MAX_IDENTITY_TOKEN_BYTES) {
    throw new Error(
      "Anthropic identity token exceeds the 16 KiB Workload Identity Federation assertion limit",
    );
  }

  const body: Record<string, string> = {
    grant_type: GRANT_TYPE_JWT_BEARER,
    assertion,
    federation_rule_id: config.federationRuleId,
    organization_id: config.organizationId,
    service_account_id: config.serviceAccountId,
  };

  if (config.workspaceId) {
    body.workspace_id = config.workspaceId;
  }

  const response = await globalThis.fetch(`${baseUrl}${TOKEN_ENDPOINT}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "anthropic-beta": `${OAUTH_API_BETA_HEADER},${FEDERATION_BETA_HEADER}`,
    },
    body: JSON.stringify(body),
  });

  const requestId = response.headers.get("request-id");

  if (!response.ok) {
    const errorBody = await response.text().catch(() => "");
    throw new Error(
      `Anthropic Workload Identity Federation token exchange failed with status ${
        response.status
      }${requestId ? ` (request-id ${requestId})` : ""}: ${redactTokenError(
        errorBody,
      )}`,
    );
  }

  const payload = (await response.json()) as {
    access_token?: unknown;
    expires_in?: unknown;
    token_type?: unknown;
  };

  if (
    typeof payload.access_token !== "string" ||
    !payload.access_token ||
    typeof payload.expires_in !== "number" ||
    !Number.isFinite(payload.expires_in)
  ) {
    throw new Error("Anthropic WIF token exchange response is missing fields");
  }

  if (
    typeof payload.token_type === "string" &&
    payload.token_type.toLowerCase() !== "bearer"
  ) {
    throw new Error(
      `Anthropic WIF token exchange returned unsupported token_type "${payload.token_type}"`,
    );
  }

  return {
    token: payload.access_token,
    expiresAtMs: Date.now() + payload.expires_in * 1000,
  };
}

function assertWorkloadIdentityConfig(
  config: AnthropicWorkloadIdentityConfig,
): void {
  const missing: string[] = [];
  if (!config.federationRuleId) {
    missing.push("ARCHESTRA_ANTHROPIC_FEDERATION_RULE_ID");
  }
  if (!config.organizationId) {
    missing.push("ARCHESTRA_ANTHROPIC_ORGANIZATION_ID");
  }
  if (!config.serviceAccountId) {
    missing.push("ARCHESTRA_ANTHROPIC_SERVICE_ACCOUNT_ID");
  }
  if (!config.identityToken && !config.identityTokenFile) {
    missing.push(
      "ARCHESTRA_ANTHROPIC_IDENTITY_TOKEN or ARCHESTRA_ANTHROPIC_IDENTITY_TOKEN_FILE",
    );
  }

  if (missing.length > 0) {
    throw new Error(
      `Anthropic Workload Identity Federation is missing required environment variables: ${missing.join(
        ", ",
      )}`,
    );
  }
}

async function readIdentityToken(
  config: AnthropicWorkloadIdentityConfig,
): Promise<string> {
  if (config.identityToken) {
    return config.identityToken;
  }

  if (!config.identityTokenFile) {
    throw new Error("Anthropic Workload Identity Federation token is missing");
  }

  const token = (await fs.readFile(config.identityTokenFile, "utf8")).trim();
  if (!token) {
    throw new Error(
      `Anthropic identity token file is empty: ${config.identityTokenFile}`,
    );
  }
  return token;
}

function requireSecureTokenEndpoint(baseUrl: string): void {
  const url = new URL(baseUrl);
  if (url.protocol === "https:") return;

  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (
    url.protocol === "http:" &&
    (host === "localhost" || host === "127.0.0.1" || host === "::1")
  ) {
    return;
  }

  throw new Error(
    `Refusing to send Anthropic Workload Identity Federation assertion to non-HTTPS endpoint: ${baseUrl}`,
  );
}

function appendAnthropicBeta(headers: Headers, beta: string): void {
  const current = headers.get("anthropic-beta");
  if (!current) {
    headers.set("anthropic-beta", beta);
    return;
  }

  const values = current.split(",").map((value) => value.trim());
  if (!values.includes(beta)) {
    headers.set("anthropic-beta", `${current},${beta}`);
  }
}

function redactTokenError(body: string): string {
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    return JSON.stringify({
      error: parsed.error,
      error_description: parsed.error_description,
      error_uri: parsed.error_uri,
    });
  } catch {
    return body.slice(0, 2000);
  }
}
