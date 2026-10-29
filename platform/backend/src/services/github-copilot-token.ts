/**
 * GitHub Copilot token exchange.
 *
 * Copilot has no static API keys. Each user holds a long-lived GitHub OAuth
 * token (`gho_…`/`ghu_…`, obtained via the GitHub device flow) which is NOT
 * accepted by the Copilot API directly. It must be exchanged at
 * `GET /copilot_internal/v2/token` for a short-lived (~30 min) bearer used
 * against https://api.githubcopilot.com.
 *
 * The exchange sits in the LLM proxy hot path, so this manager caches bearers
 * per GitHub token (refreshing 60s before expiry) and single-flights
 * concurrent exchanges for the same token.
 */
import { createHmac, randomBytes } from "node:crypto";
import { isGithubAppCredential } from "@archestra/shared";
import config from "@/config";
import { LRUCacheManager } from "@/in-memory-lru-cache";
import logger from "@/logging";
import { ApiError } from "@/types/api";
import {
  COPILOT_APP_INTEGRATION_ID,
  classifyCopilotAppRejection,
  copilotAppErrorMessage,
  type GithubAppCredential,
  GithubAppCredentialGoneError,
  GithubAppReferenceError,
  getGithubAppInstallationToken,
  resolveGithubAppCredential,
} from "./github-app-copilot-token";

// Copilot endpoints require a recognized VS Code and Copilot Chat identity.
// An hourly workflow proposes updates from stable upstream releases.
const GITHUB_COPILOT_VSCODE_VERSION = "1.144.0";
const GITHUB_COPILOT_CHAT_VERSION = "0.43.0";

/**
 * Editor-identity headers the Copilot endpoints require on every request.
 * Requests without a recognized editor identity and integration id are
 * rejected; these values match the VS Code Copilot Chat extension, the same
 * identity used by other community Copilot integrations.
 */
const GITHUB_COPILOT_HEADERS: Record<string, string> = {
  "copilot-integration-id": "vscode-chat",
  "editor-version": `vscode/${GITHUB_COPILOT_VSCODE_VERSION}`,
  "editor-plugin-version": `copilot-chat/${GITHUB_COPILOT_CHAT_VERSION}`,
  "user-agent": `GitHubCopilotChat/${GITHUB_COPILOT_CHAT_VERSION}`,
  "x-github-api-version": "2025-04-01",
};

// Not in the internal-helpers section: consts are not hoisted, and this one is
// read by a field initializer when the singleton is constructed at module eval.
const MAX_CACHED_BEARERS = 1000;

class GithubCopilotTokenManager {
  private bearerCache = new LRUCacheManager<CachedBearer>({
    maxSize: MAX_CACHED_BEARERS,
  });
  private inFlightExchanges = new Map<string, Promise<CachedBearer>>();

  /**
   * Returns a valid Copilot bearer and account API endpoint for a GitHub token,
   * exchanging (and caching) it if needed.
   */
  async getCredentials(githubToken: string): Promise<CachedBearer> {
    const cacheKey = hashToken(githubToken);

    const cached = this.bearerCache.get(cacheKey);
    if (cached && cached.expiresAtMs - REFRESH_BUFFER_MS > Date.now()) {
      return cached;
    }

    const inFlight = this.inFlightExchanges.get(cacheKey);
    if (inFlight) {
      return inFlight;
    }

    const exchange = this.exchangeToken(githubToken, cacheKey).finally(() => {
      this.inFlightExchanges.delete(cacheKey);
    });
    this.inFlightExchanges.set(cacheKey, exchange);
    return exchange;
  }

  /**
   * Drops the cached bearer for a GitHub token. Called when Copilot rejects a
   * cached bearer (e.g. revoked early) so the next request re-exchanges.
   * When `staleBearer` is given, only that exact bearer is evicted — a
   * concurrent 401 handler must not throw away a bearer another request
   * already refreshed.
   */
  invalidate(githubToken: string, staleBearer?: string): void {
    const cacheKey = hashToken(githubToken);
    if (staleBearer !== undefined) {
      const cached = this.bearerCache.get(cacheKey);
      if (cached && cached.bearer !== staleBearer) {
        return;
      }
    }
    this.bearerCache.delete(cacheKey);
  }

  private async exchangeToken(
    githubToken: string,
    cacheKey: string,
  ): Promise<CachedBearer> {
    const response = await fetch(
      config.llm["github-copilot"].tokenExchangeUrl,
      {
        headers: {
          ...GITHUB_COPILOT_HEADERS,
          accept: "application/json",
          // The exchange endpoint expects the "token" scheme, not "Bearer".
          authorization: `token ${githubToken}`,
        },
      },
    );

    if (!response.ok) {
      const body = await response.text();
      logger.warn(
        { status: response.status, body: body.slice(0, 500) },
        "[GithubCopilot] token exchange failed",
      );
      if (response.status === 401 || response.status === 403) {
        throw new ApiError(
          401,
          "GitHub token was rejected by the Copilot token exchange. Make sure the token is valid and the account has an active GitHub Copilot subscription.",
        );
      }
      throw new ApiError(
        502,
        `GitHub Copilot token exchange failed with status ${response.status}`,
      );
    }

    const payload = (await response.json()) as {
      token?: string;
      expires_at?: number;
      endpoints?: { api?: string };
    };
    if (!payload.token || typeof payload.expires_at !== "number") {
      throw new ApiError(
        502,
        "GitHub Copilot token exchange returned an unexpected payload",
      );
    }

    const expiresAtMs = payload.expires_at * 1000;
    const credentials = {
      bearer: payload.token,
      expiresAtMs,
      apiEndpoint: payload.endpoints?.api,
    };
    this.bearerCache.set(
      cacheKey,
      credentials,
      // LRU TTL is a backstop; freshness is enforced via expiresAtMs above.
      Math.max(expiresAtMs - Date.now(), 0),
    );
    return credentials;
  }
}

/** @public — exercised directly by unit tests (cache/single-flight/invalidate) */
export const githubCopilotTokenManager = new GithubCopilotTokenManager();

/**
 * Wraps fetch so every Copilot request carries a fresh short-lived bearer
 * (exchanged from the GitHub OAuth token) plus the required editor-identity
 * headers. Requests to the default host use the account endpoint returned by
 * the exchange. A 401 refreshes both the bearer and endpoint and retries once.
 *
 * Used by the github-copilot proxy adapter, its /models routes, and the model
 * fetcher (the chat LLM client routes through the local proxy instead, so the
 * exchange happens exactly once — in the adapter).
 *
 * Exchange failures are returned as a synthetic error Response rather than
 * thrown: the OpenAI SDK treats a rejecting fetch as a connection failure —
 * it would retry the exchange against GitHub and surface a generic 500
 * "Connection error." instead of the real status and message.
 */
export function createGithubCopilotFetch(params: {
  githubToken: string | undefined;
  providerApiKeyId?: string;
  /**
   * A GitHub App not stored yet, for the setup to read its models. A stored
   * plan key is never passed this way: its id is.
   */
  appCredential?: GithubAppCredential;
  innerFetch?: FetchLike;
}): FetchLike {
  const { githubToken, providerApiKeyId, appCredential, innerFetch } = params;
  const baseFetch: FetchLike = innerFetch ?? fetch;

  return async (input, init) => {
    if (appCredential) {
      return githubAppCopilotFetch({
        load: async () => ({
          storedValue: null,
          resolve: async () => appCredential,
        }),
        input,
        init,
        baseFetch,
      });
    }

    if (!githubToken) {
      // Keyless calls cannot be exchanged; let Copilot reject the request so
      // the standard provider error path reports it.
      return baseFetch(input, init);
    }

    if (isGithubAppCredential(githubToken)) {
      // A GitHub App reference is honored only as a stored plan key's own
      // value: one a caller sends could name any organization's App.
      if (!providerApiKeyId)
        return Response.json(
          {
            error: {
              message:
                "A GitHub App plan can only be used through its stored provider key.",
              type: "invalid_request_error",
            },
          },
          { status: 400 },
        );
      return githubAppCopilotFetch({
        load: () => storedPlanCredential(providerApiKeyId),
        input,
        init,
        baseFetch,
        // GitHub definitively refuses the App: the plan needs its App again,
        // like a personal sign-in needs a reconnect.
        onRejected: (storedValue) =>
          recordAppKeyRejected({ providerApiKeyId, storedValue }),
      });
    }

    const doFetch = async (credentials: CachedBearer) => {
      const headers = new Headers(
        init?.headers ?? (input instanceof Request ? input.headers : undefined),
      );
      for (const [name, value] of Object.entries(GITHUB_COPILOT_HEADERS)) {
        headers.set(name, value);
      }
      headers.set("authorization", `Bearer ${credentials.bearer}`);
      return baseFetch(
        resolveCopilotRequestUrl(input, credentials.apiEndpoint),
        { ...init, headers },
      );
    };

    const recordFailure = async () => {
      if (!providerApiKeyId) return;
      const { recordSubscriptionAuthenticationFailure } = await import(
        "./subscription-authentication-status"
      );
      await recordSubscriptionAuthenticationFailure({
        providerApiKeyId,
        provider: "github-copilot",
        matchesCredential: (stored) => stored === githubToken,
      });
    };
    let credentials: CachedBearer;
    try {
      credentials = await githubCopilotTokenManager.getCredentials(githubToken);
    } catch (error) {
      if (error instanceof ApiError && error.statusCode === 401)
        await recordFailure();
      return exchangeErrorResponse(error);
    }
    const response = await doFetch(credentials);

    // A cached bearer can be rejected before its reported expiry (e.g. seat
    // revoked, token rotated). Re-exchange once; non-replayable bodies are
    // never produced by our SDK clients (they serialize JSON strings).
    const bodyIsReplayable =
      init?.body === undefined || typeof init.body === "string";
    if (response.status === 401 && bodyIsReplayable) {
      await response.body?.cancel();
      githubCopilotTokenManager.invalidate(githubToken, credentials.bearer);
      let freshCredentials: CachedBearer;
      try {
        freshCredentials =
          await githubCopilotTokenManager.getCredentials(githubToken);
      } catch (error) {
        if (error instanceof ApiError && error.statusCode === 401)
          await recordFailure();
        return exchangeErrorResponse(error);
      }
      const retried = await doFetch(freshCredentials);
      if (retried.status === 401) await recordFailure();
      return retried;
    }

    return response;
  };
}

// ===== Internal helpers =====

type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

interface CachedBearer {
  bearer: string;
  expiresAtMs: number;
  apiEndpoint?: string;
}

/** Refresh this long before the bearer's reported expiry. */
const REFRESH_BUFFER_MS = 60 * 1000;

/**
 * Converts a token-exchange ApiError into an OpenAI-shaped error Response so
 * SDK consumers raise a proper status error (no retries, real message).
 */
function exchangeErrorResponse(error: unknown): Response {
  if (error instanceof ApiError) {
    return Response.json(
      {
        error: {
          message: error.message,
          type: error.statusCode === 401 ? "authentication_error" : "api_error",
        },
      },
      { status: error.statusCode },
    );
  }
  throw error;
}

// Per-process random key for the cache-key HMAC below. Regenerated on each
// boot — the cache is in-memory only, so a cold start on restart is fine.
const TOKEN_CACHE_HMAC_KEY = randomBytes(32);

// Derives an in-memory cache key for the bearer LRU. It is never stored,
// persisted, or compared against a stored hash, so a slow password KDF
// (bcrypt/scrypt/argon2) would only add latency to every proxy request. HMAC
// with a per-process key (rather than bare SHA-256) means an observer of cache
// keys can't pre-compute lookups against known token formats.
function hashToken(token: string): string {
  return createHmac("sha256", TOKEN_CACHE_HMAC_KEY).update(token).digest("hex");
}

/** Use GitHub's account endpoint only for requests to the default API host. */
function resolveCopilotRequestUrl(
  input: string | URL | Request,
  apiEndpoint: string | undefined,
): string | URL | Request {
  if (!apiEndpoint) return input;
  const url = new URL(input instanceof Request ? input.url : input);
  // Explicit custom base URLs (including GHE and local proxies) take precedence.
  if (url.origin !== "https://api.githubcopilot.com") return input;
  const base = new URL(apiEndpoint);
  base.pathname = `${base.pathname.replace(/\/$/, "")}${url.pathname}`;
  base.search = url.search;
  base.hash = "";
  return input instanceof Request ? new Request(base, input) : base;
}

/**
 * Copilot request with a GitHub App credential: an installation token as the
 * Bearer, with the Copilot runtime's integration id and no editor identity.
 * A 401 mints a fresh token and retries once. Only a definitive refusal of
 * the App flags the plan; a refusal of one request passes through.
 */
async function githubAppCopilotFetch(params: {
  /**
   * The stored key value (null when not stored), then the App it names:
   * resolving can fail definitively after the value is known.
   */
  load: () => Promise<{
    storedValue: string | null;
    resolve: () => Promise<GithubAppCredential>;
  }>;
  input: string | URL | Request;
  init?: RequestInit;
  baseFetch: FetchLike;
  onRejected?: (storedValue: string | null) => Promise<void>;
}): Promise<Response> {
  const { input, init, baseFetch } = params;
  let storedValue: string | null = null;
  let credential: GithubAppCredential;
  try {
    const loaded = await params.load();
    storedValue = loaded.storedValue;
    credential = await loaded.resolve();
  } catch (error) {
    return appSignInFailure(error, rejectedFor(storedValue));
  }
  const onRejected = rejectedFor(storedValue);
  function rejectedFor(value: string | null) {
    return params.onRejected
      ? () => params.onRejected?.(value) ?? Promise.resolve()
      : undefined;
  }
  const send = (token: string) => {
    const headers = new Headers(
      init?.headers ?? (input instanceof Request ? input.headers : undefined),
    );
    headers.set("copilot-integration-id", COPILOT_APP_INTEGRATION_ID);
    headers.set("authorization", `Bearer ${token}`);
    return baseFetch(input, { ...init, headers });
  };
  let token: string;
  try {
    token = await getGithubAppInstallationToken(credential);
  } catch (error) {
    return appSignInFailure(error, onRejected);
  }
  try {
    let response = await send(token);
    const bodyIsReplayable =
      init?.body === undefined || typeof init.body === "string";
    if (response.status === 401 && bodyIsReplayable) {
      await response.body?.cancel();
      try {
        token = await getGithubAppInstallationToken(credential, {
          forceRefresh: true,
        });
      } catch (error) {
        return appSignInFailure(error, onRejected);
      }
      response = await send(token);
    }
    if (response.status !== 400 && response.status !== 403) return response;
    const text = await response.text();
    const githubMessage = githubMessageOf(text);
    const rejection = classifyCopilotAppRejection({
      status: response.status,
      githubMessage,
    });
    if (!rejection) {
      // One request refused (a payload Copilot rejects, a model the policy
      // blocks): an ordinary error, and the plan stays connected.
      if (response.status === 400)
        return new Response(text, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        });
      return Response.json(
        {
          error: {
            message: copilotAppErrorMessage({
              rejection,
              status: response.status,
              githubMessage,
              organization: credential.organization,
            }),
            type: "permission_error",
          },
        },
        { status: 403 },
      );
    }
    logger.info(
      { rejection, message: githubMessage.slice(0, 300) },
      "[GithubAppCopilot] Copilot refused the App",
    );
    await onRejected?.();
    return Response.json(
      {
        error: {
          message: copilotAppErrorMessage({
            rejection,
            status: response.status,
            githubMessage,
            organization: credential.organization,
          }),
          type: "authentication_error",
        },
      },
      { status: 401 },
    );
  } catch (error) {
    return exchangeErrorResponse(error);
  }
}

function githubMessageOf(text: string): string {
  try {
    const parsed = JSON.parse(text) as {
      message?: unknown;
      error?: { message?: unknown };
    };
    const message =
      typeof parsed.message === "string"
        ? parsed.message
        : typeof parsed.error?.message === "string"
          ? parsed.error.message
          : null;
    if (message) return message.trim().slice(0, 300);
  } catch {
    // Not JSON.
  }
  return text.trim().slice(0, 300);
}

/**
 * Why the App could not sign in: GitHub definitively refused it (the plan is
 * flagged), the stored value is no plan reference (refused, not flagged), or
 * GitHub or the credential store failed for now (a transient error, not
 * flagged).
 */
async function appSignInFailure(
  error: unknown,
  onRejected: (() => Promise<void>) | undefined,
): Promise<Response> {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof GithubAppReferenceError)
    return Response.json(
      { error: { message, type: "invalid_request_error" } },
      { status: 400 },
    );
  const refused = isDefinitiveRefusal(error);
  logger.info(
    { refused, message: message.slice(0, 300) },
    "[GithubAppCopilot] installation token mint failed",
  );
  if (!refused)
    return Response.json(
      {
        error: {
          message: `GitHub didn't answer for the App. Try again in a moment. GitHub said: "${message}"`,
          type: "api_error",
        },
      },
      { status: 503 },
    );
  await onRejected?.();
  return Response.json(
    {
      error: {
        message:
          error instanceof GithubAppCredentialGoneError
            ? message
            : `GitHub refused the App. Reconnect it with current App credentials. GitHub said: "${message}"`,
        type: "authentication_error",
      },
    },
    { status: 401 },
  );
}

/**
 * GitHub's definitive refusal of the App: its credential is gone, its key is
 * unusable, or minting a token answered 401 (key or JWT refused) or 404 (App
 * or installation gone). Rate limits and outages are not.
 */
function isDefinitiveRefusal(error: unknown): boolean {
  if (error instanceof GithubAppCredentialGoneError) return true;
  if (!(error instanceof ApiError)) return false;
  if (
    error.statusCode === 400 &&
    /installation was not found|private key is invalid/i.test(error.message)
  )
    return true;
  return /installation token: (401|404)\b/.test(error.message);
}

/** The plan key's App, read from the key's own stored value only. */
async function storedPlanCredential(providerApiKeyId: string) {
  const [
    { default: LlmProviderApiKeyModel },
    { getSecretValueForLlmProviderApiKey },
  ] = await Promise.all([
    import("@/models/llm-provider-api-key"),
    import("@/secrets-manager"),
  ]);
  const key = await LlmProviderApiKeyModel.findById(providerApiKeyId);
  if (
    !key ||
    key.provider !== "github-copilot" ||
    !key.secretId ||
    !(await LlmProviderApiKeyModel.isGithubAppKey(key.id))
  )
    throw new GithubAppReferenceError(
      "This provider key is not a GitHub App plan.",
    );
  const stored = await getSecretValueForLlmProviderApiKey(key.secretId);
  const storedValue = typeof stored === "string" ? stored : null;
  return {
    storedValue,
    resolve: () =>
      resolveGithubAppCredential({
        value: storedValue,
        organizationId: key.organizationId,
      }),
  };
}

async function recordAppKeyRejected(params: {
  providerApiKeyId: string;
  storedValue: string | null;
}) {
  if (!params.storedValue) return;
  const { recordSubscriptionAuthenticationFailure } = await import(
    "./subscription-authentication-status"
  );
  await recordSubscriptionAuthenticationFailure({
    providerApiKeyId: params.providerApiKeyId,
    provider: "github-copilot",
    // Only the value that failed: a key re-pointed since keeps working.
    matchesCredential: (stored) => stored === params.storedValue,
  });
}
