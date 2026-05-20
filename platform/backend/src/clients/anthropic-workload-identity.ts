import { readFile } from "node:fs/promises";
import config from "@/config";

const ANTHROPIC_WIF_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:jwt-bearer";
const TOKEN_REFRESH_SKEW_MS = 120_000;

export const ANTHROPIC_WIF_API_KEY_PLACEHOLDER =
  "ARCHESTRA_ANTHROPIC_WIF_KEYLESS";

type CachedToken = {
  accessToken: string;
  expiresAtMs: number;
};

let cachedToken: CachedToken | null = null;
let pendingExchange: Promise<CachedToken> | null = null;

export function isAnthropicWorkloadIdentityEnabled(): boolean {
  const wif = config.llm.anthropic.workloadIdentity;
  return (
    wif.enabled &&
    Boolean(wif.federationRuleId) &&
    Boolean(wif.organizationId) &&
    Boolean(wif.serviceAccountId) &&
    Boolean(wif.identityToken || wif.identityTokenFile)
  );
}

export function createAnthropicWorkloadIdentityFetch(
  baseFetch: typeof globalThis.fetch | undefined,
): typeof globalThis.fetch {
  return async (input, init) => {
    const fetchFn = baseFetch ?? globalThis.fetch;
    const headers = new Headers(init?.headers);
    headers.delete("x-api-key");
    headers.set(
      "Authorization",
      `Bearer ${await getAnthropicWorkloadIdentityBearerToken(fetchFn)}`,
    );

    return fetchFn(input, {
      ...init,
      headers,
    });
  };
}

export async function getAnthropicWorkloadIdentityBearerToken(
  fetchFn: typeof globalThis.fetch = globalThis.fetch,
): Promise<string> {
  const now = Date.now();
  if (cachedToken && cachedToken.expiresAtMs - TOKEN_REFRESH_SKEW_MS > now) {
    return cachedToken.accessToken;
  }

  if (!pendingExchange) {
    pendingExchange = exchangeAnthropicWorkloadIdentityToken(fetchFn).finally(
      () => {
        pendingExchange = null;
      },
    );
  }

  cachedToken = await pendingExchange;
  return cachedToken.accessToken;
}

async function exchangeAnthropicWorkloadIdentityToken(
  fetchFn: typeof globalThis.fetch,
): Promise<CachedToken> {
  const wif = config.llm.anthropic.workloadIdentity;
  const assertion = await getIdentityToken();
  const response = await fetchFn(getTokenUrl(), {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      grant_type: ANTHROPIC_WIF_GRANT_TYPE,
      assertion,
      federation_rule_id: wif.federationRuleId,
      organization_id: wif.organizationId,
      service_account_id: wif.serviceAccountId,
      ...(wif.workspaceId ? { workspace_id: wif.workspaceId } : {}),
    }),
  });

  if (!response.ok) {
    const errorBody = await response.text().catch(() => "");
    throw new Error(
      `Anthropic workload identity token exchange failed with status ${response.status}: ${errorBody}`,
    );
  }

  const tokenResponse = (await response.json()) as {
    access_token?: unknown;
    token_type?: unknown;
    expires_in?: unknown;
  };
  if (typeof tokenResponse.access_token !== "string") {
    throw new Error(
      "Anthropic workload identity token response was missing access_token",
    );
  }
  if (
    tokenResponse.token_type &&
    String(tokenResponse.token_type).toLowerCase() !== "bearer"
  ) {
    throw new Error(
      "Anthropic workload identity token response was not a bearer token",
    );
  }

  const expiresInSeconds =
    typeof tokenResponse.expires_in === "number" &&
    Number.isFinite(tokenResponse.expires_in)
      ? tokenResponse.expires_in
      : 3600;

  return {
    accessToken: tokenResponse.access_token,
    expiresAtMs: Date.now() + expiresInSeconds * 1000,
  };
}

async function getIdentityToken(): Promise<string> {
  const { identityToken, identityTokenFile } =
    config.llm.anthropic.workloadIdentity;
  if (identityToken) {
    return identityToken;
  }
  if (identityTokenFile) {
    return (await readFile(identityTokenFile, "utf8")).trim();
  }
  throw new Error(
    "Anthropic workload identity requires ARCHESTRA_ANTHROPIC_WIF_IDENTITY_TOKEN or ARCHESTRA_ANTHROPIC_WIF_IDENTITY_TOKEN_FILE",
  );
}

function getTokenUrl(): string {
  const wif = config.llm.anthropic.workloadIdentity;
  if (wif.tokenUrl) {
    return wif.tokenUrl;
  }

  return `${config.llm.anthropic.baseUrl.replace(/\/+$/, "")}/v1/oauth/token`;
}

export const __test = {
  resetTokenCache() {
    cachedToken = null;
    pendingExchange = null;
  },
};
