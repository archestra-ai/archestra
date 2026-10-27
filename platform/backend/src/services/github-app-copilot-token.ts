/**
 * GitHub App credentials for GitHub Copilot.
 *
 * An organization can let a GitHub App (organization permission "Copilot
 * Requests") call Copilot on its behalf, billed to the organization. The key
 * stores the App ID, installation ID and private key as one marker-encoded
 * value. Archestra signs an App JWT, mints a short-lived installation token
 * (`ghs_…`, ~1 hour) and uses it against Copilot.
 *
 * The preview does not document how Copilot accepts an installation token, so
 * the first use of a credential tries each known wire mode against GET /models
 * and remembers the one that works (see COPILOT_APP_WIRE_MODES).
 */
import { createHash, createPrivateKey, createSign } from "node:crypto";
import { GITHUB_APP_CREDENTIAL_MARKER } from "@archestra/shared";
import config from "@/config";
import { LRUCacheManager } from "@/in-memory-lru-cache";
import logger from "@/logging";
import { ApiError } from "@/types/api";

export interface GithubAppCredential {
  appId: string;
  installationId: string;
  privateKey: string;
}

/**
 * How a minted installation token is presented to Copilot. Copilot requires
 * `copilot-integration-id` to identify the App that issued the token, so the
 * Bearer modes carry the integration id that worked.
 */
export type CopilotAppWireMode =
  /** Bearer token with only `copilot-integration-id: <integrationId>`. */
  | { mode: "B"; integrationId: string }
  /** Bearer token with the editor headers, integration id overridden. */
  | { mode: "A"; integrationId: string }
  /** Installation token exchanged at copilot_internal/v2/token first. */
  | { mode: "C" };

/** Public, non-secret identity of a GitHub App (GET /app). */
interface GithubAppIdentity {
  id: number | null;
  slug: string | null;
  clientId: string | null;
}

/**
 * Integration ids to try for an App, in order: the configured override, the
 * Copilot runtime's default, then the App's client id, slug and numeric id.
 * Falls back to the App ID from the credential when GET /app failed.
 */
export function githubAppIntegrationIdCandidates(params: {
  identity: GithubAppIdentity | null;
  appId: string;
  configured?: string;
}): string[] {
  const { identity, appId, configured } = params;
  const candidates = [
    configured?.trim(),
    // The Copilot runtime's default Copilot-Integration-Id, as named in
    // GitHub's Copilot SDK docs (docs/setup/multi-tenancy.md); GitHub says
    // that runtime works with installation tokens.
    COPILOT_RUNTIME_INTEGRATION_ID,
    identity?.clientId,
    identity?.slug,
    identity?.id != null ? String(identity.id) : appId,
  ].filter((value): value is string => typeof value === "string" && !!value);
  return [...new Set(candidates)];
}

const COPILOT_RUNTIME_INTEGRATION_ID = "copilot-developer-cli";

export function encodeGithubAppCredential(
  credential: GithubAppCredential,
): string {
  const json = JSON.stringify(credential);
  return `${GITHUB_APP_CREDENTIAL_MARKER}${Buffer.from(json, "utf8").toString("base64url")}`;
}

export function decodeGithubAppCredential(
  value: string | null | undefined,
): GithubAppCredential | null {
  if (!value || !value.startsWith(GITHUB_APP_CREDENTIAL_MARKER)) return null;
  try {
    const json = Buffer.from(
      value.slice(GITHUB_APP_CREDENTIAL_MARKER.length),
      "base64url",
    ).toString("utf8");
    const parsed = JSON.parse(json) as Partial<GithubAppCredential>;
    if (
      typeof parsed.appId !== "string" ||
      typeof parsed.installationId !== "string" ||
      typeof parsed.privateKey !== "string"
    ) {
      return null;
    }
    return {
      appId: parsed.appId,
      installationId: parsed.installationId,
      privateKey: parsed.privateKey,
    };
  } catch {
    return null;
  }
}

/**
 * Validate user input for a GitHub App credential. Throws a 400 naming the
 * bad field; never echoes the private key.
 */
export function validateGithubAppCredential(
  credential: GithubAppCredential,
): GithubAppCredential {
  const appId = credential.appId.trim();
  const installationId = credential.installationId.trim();
  if (!/^\d+$/.test(appId)) {
    throw new ApiError(400, "GitHub App ID must be a number.");
  }
  if (!/^\d+$/.test(installationId)) {
    throw new ApiError(400, "GitHub App installation ID must be a number.");
  }
  const privateKey = credential.privateKey.trim();
  try {
    const key = createPrivateKey(privateKey);
    if (key.asymmetricKeyType !== "rsa") throw new Error("not rsa");
  } catch {
    throw new ApiError(
      400,
      "GitHub App private key must be the RSA PEM file downloaded from the App settings.",
    );
  }
  return { appId, installationId, privateKey: `${privateKey}\n` };
}

/**
 * RS256 GitHub App JWT: issued 60s in the past against clock drift, valid for
 * 9 minutes (GitHub's limit is 10).
 *
 * @public — exercised directly by unit tests (JWT shape and signature)
 */
export function createGithubAppJwt(params: {
  appId: string;
  privateKey: string;
  nowSeconds?: number;
}): string {
  const now = params.nowSeconds ?? Math.floor(Date.now() / 1000);
  const header = base64urlJson({ alg: "RS256", typ: "JWT" });
  const payload = base64urlJson({
    iat: now - 60,
    exp: now + 9 * 60,
    iss: params.appId,
  });
  const signingInput = `${header}.${payload}`;
  const signature = createSign("RSA-SHA256")
    .update(signingInput)
    .sign(params.privateKey)
    .toString("base64url");
  return `${signingInput}.${signature}`;
}

// Not in the internal-helpers section: consts are not hoisted, and this one is
// read by field initializers when the singleton is constructed at module eval.
const MAX_CACHED_TOKENS = 200;

class GithubAppCopilotTokenManager {
  private tokenCache = new LRUCacheManager<InstallationToken>({
    maxSize: MAX_CACHED_TOKENS,
  });
  private wireModes = new LRUCacheManager<CopilotAppWireMode>({
    maxSize: MAX_CACHED_TOKENS,
  });
  private identities = new LRUCacheManager<GithubAppIdentity>({
    maxSize: MAX_CACHED_TOKENS,
  });
  private inFlight = new Map<string, Promise<InstallationToken>>();

  /**
   * The App's public identity from GET /app, cached per credential. Returns
   * null when GitHub refuses (logged); callers then fall back to the App ID.
   */
  async getAppIdentity(
    credential: GithubAppCredential,
  ): Promise<GithubAppIdentity | null> {
    const cacheKey = credentialCacheKey(credential);
    const cached = this.identities.get(cacheKey);
    if (cached) return cached;
    const response = await fetch(
      `${config.llm["github-copilot"].appApiBaseUrl.replace(/\/$/, "")}/app`,
      {
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${createGithubAppJwt(credential)}`,
          "x-github-api-version": "2022-11-28",
        },
      },
    );
    if (!response.ok) {
      logger.info(
        {
          status: response.status,
          message: await githubErrorMessage(response),
          appId: credential.appId,
        },
        "[GithubAppCopilot] GET /app failed",
      );
      return null;
    }
    const payload = (await response.json()) as {
      id?: unknown;
      slug?: unknown;
      client_id?: unknown;
    };
    const identity: GithubAppIdentity = {
      id: typeof payload.id === "number" ? payload.id : null,
      slug: typeof payload.slug === "string" ? payload.slug : null,
      clientId:
        typeof payload.client_id === "string" ? payload.client_id : null,
    };
    this.identities.set(cacheKey, identity);
    logger.info(
      { appId: credential.appId, ...identity },
      "[GithubAppCopilot] App identity",
    );
    return identity;
  }

  /** A valid installation token for the credential, minting when needed. */
  async getInstallationToken(
    credential: GithubAppCredential,
  ): Promise<InstallationToken> {
    const cacheKey = credentialCacheKey(credential);
    const cached = this.tokenCache.get(cacheKey);
    if (cached && cached.expiresAtMs - REFRESH_BUFFER_MS > Date.now()) {
      return cached;
    }
    const pending = this.inFlight.get(cacheKey);
    if (pending) return pending;
    const mint = this.mint(credential, cacheKey).finally(() => {
      this.inFlight.delete(cacheKey);
    });
    this.inFlight.set(cacheKey, mint);
    return mint;
  }

  /** Drop the cached installation token, unless it was already replaced. */
  invalidate(credential: GithubAppCredential, staleToken?: string): void {
    const cacheKey = credentialCacheKey(credential);
    if (staleToken !== undefined) {
      const cached = this.tokenCache.get(cacheKey);
      if (cached && cached.token !== staleToken) return;
    }
    this.tokenCache.delete(cacheKey);
  }

  getWireMode(credential: GithubAppCredential): CopilotAppWireMode | null {
    return this.wireModes.get(credentialCacheKey(credential)) ?? null;
  }

  setWireMode(credential: GithubAppCredential, mode: CopilotAppWireMode) {
    this.wireModes.set(credentialCacheKey(credential), mode);
  }

  clearWireMode(credential: GithubAppCredential): void {
    this.wireModes.delete(credentialCacheKey(credential));
  }

  private async mint(
    credential: GithubAppCredential,
    cacheKey: string,
  ): Promise<InstallationToken> {
    let jwt: string;
    try {
      jwt = createGithubAppJwt(credential);
    } catch {
      throw new ApiError(
        400,
        "GitHub App private key could not sign a token. Upload the PEM file again.",
      );
    }
    const url = `${config.llm["github-copilot"].appApiBaseUrl.replace(/\/$/, "")}/app/installations/${encodeURIComponent(credential.installationId)}/access_tokens`;
    const response = await fetch(url, {
      method: "POST",
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${jwt}`,
        "content-type": "application/json",
        "x-github-api-version": "2022-11-28",
      },
      body: JSON.stringify({
        permissions: { organization_copilot_requests: "read" },
      }),
    });
    if (!response.ok) {
      const message = await githubErrorMessage(response);
      logger.info(
        {
          status: response.status,
          appId: credential.appId,
          installationId: credential.installationId,
        },
        "[GithubAppCopilot] installation token mint failed",
      );
      throw new ApiError(
        response.status < 500 ? 401 : 502,
        `GitHub rejected the App installation token request (${response.status}): ${message}`,
      );
    }
    const payload = (await response.json()) as {
      token?: string;
      expires_at?: string;
    };
    const expiresAtMs = payload.expires_at
      ? Date.parse(payload.expires_at)
      : Number.NaN;
    if (!payload.token || Number.isNaN(expiresAtMs)) {
      throw new ApiError(
        502,
        "GitHub returned an unexpected installation token payload",
      );
    }
    const token = { token: payload.token, expiresAtMs };
    this.tokenCache.set(cacheKey, token, Math.max(expiresAtMs - Date.now(), 0));
    logger.info(
      { appId: credential.appId, installationId: credential.installationId },
      "[GithubAppCopilot] minted installation token",
    );
    return token;
  }
}

/** @public — exercised directly by unit tests */
export const githubAppCopilotTokenManager = new GithubAppCopilotTokenManager();

interface InstallationToken {
  token: string;
  expiresAtMs: number;
}

/** Read GitHub's `message` from an error response, bounded and without secrets. */
export async function githubErrorMessage(response: Response): Promise<string> {
  const text = await response.text().catch(() => "");
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
    if (message) return message.slice(0, 300);
  } catch {
    // Not JSON.
  }
  return text.slice(0, 300) || response.statusText || "no message";
}

// ===== Internal helpers =====

/** Refresh an installation token this long before its reported expiry. */
const REFRESH_BUFFER_MS = 5 * 60 * 1000;

function base64urlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

/**
 * In-memory cache key for a credential. Hashing the whole credential means a
 * rotated private key or a changed installation never reuses an old token.
 */
function credentialCacheKey(credential: GithubAppCredential): string {
  return createHash("sha256")
    .update(
      `${credential.appId}\0${credential.installationId}\0${credential.privateKey}`,
    )
    .digest("hex");
}
