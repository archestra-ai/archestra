import { readFile } from "node:fs/promises";
import config from "@/config";
import logger from "@/logging";

/**
 * Anthropic Workload Identity Federation (WIF) client.
 *
 * Exchanges an IdP-issued OIDC identity token for a short-lived Anthropic
 * access token via the RFC 7523 `jwt-bearer` grant and injects it as an
 * `Authorization: Bearer` header on upstream Anthropic requests. Configured
 * exclusively through backend env vars (see `config.llm.anthropic.wif`) —
 * WIF is admin-controlled infrastructure auth, never per-request input.
 *
 * Token caching mirrors the official SDKs' two-tier refresh schedule: an
 * advisory refresh 120s before expiry (serve the cached token if the exchange
 * fails) and a mandatory refresh 30s before expiry (fail hard).
 *
 * @see https://platform.claude.com/docs/en/manage-claude/workload-identity-federation
 */
class AnthropicWorkloadIdentityClient {
  private cachedToken: TokenCacheEntry | null = null;
  private inFlightExchange: Promise<TokenCacheEntry> | null = null;

  /**
   * Whether keyless Anthropic auth via WIF should be used. Requires complete
   * WIF env configuration, and — matching the official SDKs' credential
   * precedence — is shadowed by static SDK env credentials
   * (`ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN`) when those are set.
   */
  isEnabled(): boolean {
    return config.llm.anthropic.wif !== null && !hasStaticSdkEnvCredentials();
  }

  /**
   * Wrap a fetch implementation so every request carries a fresh federated
   * bearer token. Replaces any `x-api-key` header the SDK may have set.
   */
  createFetch(baseFetch?: typeof fetch): typeof fetch {
    const fetchFn = baseFetch ?? fetch;

    return (async (input: RequestInfo | URL, init?: RequestInit) => {
      const token = await this.getAccessToken();
      const headers = mergeHeaders(input, init);
      headers.delete("x-api-key");
      headers.set("authorization", `Bearer ${token}`);
      return fetchFn(input, { ...init, headers });
    }) as typeof fetch;
  }

  async getAccessToken(): Promise<string> {
    const now = Date.now();
    const cached = this.cachedToken;
    if (cached && now < cached.expiresAtMs - ADVISORY_REFRESH_MS) {
      return cached.accessToken;
    }

    try {
      return (await this.refreshToken()).accessToken;
    } catch (error) {
      // Advisory window: the cached token is still comfortably valid, so keep
      // serving it when the token endpoint is unreachable. Inside the
      // mandatory window the token is too close to expiry — surface the error.
      if (cached && now < cached.expiresAtMs - MANDATORY_REFRESH_MS) {
        logger.warn(
          {
            errorMessage:
              error instanceof Error ? error.message : String(error),
          },
          "Anthropic WIF token refresh failed; serving cached token",
        );
        return cached.accessToken;
      }
      throw error;
    }
  }

  resetForTests(): void {
    this.cachedToken = null;
    this.inFlightExchange = null;
  }

  /** Deduplicates concurrent exchanges into a single in-flight request. */
  private refreshToken(): Promise<TokenCacheEntry> {
    this.inFlightExchange ??= this.exchangeToken()
      .then((entry) => {
        this.cachedToken = entry;
        return entry;
      })
      .finally(() => {
        this.inFlightExchange = null;
      });
    return this.inFlightExchange;
  }

  private async exchangeToken(): Promise<TokenCacheEntry> {
    const wif = config.llm.anthropic.wif;
    if (!wif) {
      throw new Error(
        "Anthropic Workload Identity Federation is not configured",
      );
    }

    const assertion = await readIdentityToken(wif);
    // The exchange targets the configured Anthropic base URL (matching the
    // official SDK's oidcFederationProvider({ baseURL }) behavior) so it can be
    // routed through a proxy. WIF and the Azure Foundry base URL never collide:
    // the Foundry Entra ID path is checked before WIF in every call site.
    const response = await fetch(
      `${normalizeBaseUrl(config.llm.anthropic.baseUrl)}/v1/oauth/token`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          grant_type: JWT_BEARER_GRANT_TYPE,
          assertion,
          federation_rule_id: wif.federationRuleId,
          organization_id: wif.organizationId,
          service_account_id: wif.serviceAccountId,
          ...(wif.workspaceId ? { workspace_id: wif.workspaceId } : {}),
        }),
      },
    );

    if (!response.ok) {
      const requestId = response.headers.get("request-id");
      throw new Error(
        `Anthropic Workload Identity Federation token exchange failed with status ${response.status}${requestId ? ` (request-id: ${requestId})` : ""}`,
      );
    }

    const data = (await response.json()) as {
      access_token?: unknown;
      expires_in?: unknown;
    };
    if (
      typeof data.access_token !== "string" ||
      data.access_token.length === 0 ||
      typeof data.expires_in !== "number" ||
      !Number.isFinite(data.expires_in) ||
      data.expires_in <= 0
    ) {
      throw new Error(
        "Anthropic Workload Identity Federation token exchange returned an invalid token response",
      );
    }

    return {
      accessToken: data.access_token,
      expiresAtMs: Date.now() + data.expires_in * 1000,
    };
  }
}

export const anthropicWorkloadIdentity = new AnthropicWorkloadIdentityClient();

// === Internal helpers ===

const JWT_BEARER_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:jwt-bearer";
const ADVISORY_REFRESH_MS = 120_000;
const MANDATORY_REFRESH_MS = 30_000;

interface TokenCacheEntry {
  accessToken: string;
  expiresAtMs: number;
}

/**
 * The Anthropic SDKs place static env credentials above federation in their
 * credential precedence; these are the SDK's own ambient env vars, not
 * ARCHESTRA_-prefixed config.
 */
function hasStaticSdkEnvCredentials(): boolean {
  return Boolean(
    process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN,
  );
}

/**
 * The identity token file is re-read on every exchange so rotated projected
 * tokens (e.g. Kubernetes service-account tokens) are picked up transparently.
 */
async function readIdentityToken(wif: {
  identityTokenFile?: string;
  identityToken?: string;
}): Promise<string> {
  if (wif.identityTokenFile) {
    return (await readFile(wif.identityTokenFile, "utf8")).trim();
  }
  if (wif.identityToken) {
    return wif.identityToken;
  }
  throw new Error(
    "Anthropic Workload Identity Federation has no identity token source configured",
  );
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

function mergeHeaders(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
): Headers {
  const headers = new Headers(
    input instanceof Request ? input.headers : undefined,
  );
  for (const [key, value] of new Headers(init?.headers).entries()) {
    headers.set(key, value);
  }
  return headers;
}
