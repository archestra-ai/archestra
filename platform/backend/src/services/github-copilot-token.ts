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
import { LRUCacheManager } from "@/cache-manager";
import config from "@/config";
import logger from "@/logging";
import { ApiError } from "@/types";

/**
 * Editor-identity headers the Copilot endpoints require on every request.
 * Requests without a recognized editor identity and integration id are
 * rejected; these values match the VS Code Copilot Chat extension, the same
 * identity used by other community Copilot integrations.
 */
const GITHUB_COPILOT_HEADERS: Record<string, string> = {
  "copilot-integration-id": "vscode-chat",
  "editor-version": "vscode/1.99.0",
  "editor-plugin-version": "copilot-chat/0.26.7",
  "user-agent": "GitHubCopilotChat/0.26.7",
  "x-github-api-version": "2025-04-01",
};

// Not in the internal-helpers section: consts are not hoisted, and this one is
// read by a field initializer when the singleton is constructed at module eval.
const MAX_CACHED_BEARERS = 1000;

class GithubCopilotTokenManager {
  private bearerCache = new LRUCacheManager<CachedBearer>({
    maxSize: MAX_CACHED_BEARERS,
  });
  private inFlightExchanges = new Map<string, Promise<string>>();

  /**
   * Returns a valid Copilot API bearer for the given GitHub OAuth token,
   * exchanging (and caching) it if needed.
   */
  async getBearerToken(githubToken: string): Promise<string> {
    const cacheKey = hashToken(githubToken);

    const cached = this.bearerCache.get(cacheKey);
    if (cached && cached.expiresAtMs - REFRESH_BUFFER_MS > Date.now()) {
      return cached.bearer;
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
  ): Promise<string> {
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
    };
    if (!payload.token || typeof payload.expires_at !== "number") {
      throw new ApiError(
        502,
        "GitHub Copilot token exchange returned an unexpected payload",
      );
    }

    const expiresAtMs = payload.expires_at * 1000;
    this.bearerCache.set(
      cacheKey,
      { bearer: payload.token, expiresAtMs },
      // LRU TTL is a backstop; freshness is enforced via expiresAtMs above.
      Math.max(expiresAtMs - Date.now(), 0),
    );
    return payload.token;
  }
}

/** @public — exercised directly by unit tests (cache/single-flight/invalidate) */
export const githubCopilotTokenManager = new GithubCopilotTokenManager();

/**
 * Wraps fetch so every Copilot request carries a fresh short-lived bearer
 * (exchanged from the GitHub OAuth token) plus the required editor-identity
 * headers. A 401 on a cached bearer invalidates it and retries exactly once.
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
  innerFetch?: FetchLike;
}): FetchLike {
  const { githubToken, innerFetch } = params;
  const baseFetch: FetchLike = innerFetch ?? fetch;

  return async (input, init) => {
    if (!githubToken) {
      // Keyless calls cannot be exchanged; let Copilot reject the request so
      // the standard provider error path reports it.
      return baseFetch(input, init);
    }

    const doFetch = async (bearer: string) => {
      const headers = new Headers(init?.headers);
      for (const [name, value] of Object.entries(GITHUB_COPILOT_HEADERS)) {
        headers.set(name, value);
      }
      headers.set("authorization", `Bearer ${bearer}`);
      return baseFetch(input, { ...init, headers });
    };

    let bearer: string;
    try {
      bearer = await githubCopilotTokenManager.getBearerToken(githubToken);
    } catch (error) {
      return exchangeErrorResponse(error);
    }
    const response = await doFetch(bearer);

    // A cached bearer can be rejected before its reported expiry (e.g. seat
    // revoked, token rotated). Re-exchange once; non-replayable bodies are
    // never produced by our SDK clients (they serialize JSON strings).
    const bodyIsReplayable =
      init?.body === undefined || typeof init.body === "string";
    if (response.status === 401 && bodyIsReplayable) {
      await response.body?.cancel();
      githubCopilotTokenManager.invalidate(githubToken, bearer);
      let freshBearer: string;
      try {
        freshBearer =
          await githubCopilotTokenManager.getBearerToken(githubToken);
      } catch (error) {
        return exchangeErrorResponse(error);
      }
      return doFetch(freshBearer);
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
