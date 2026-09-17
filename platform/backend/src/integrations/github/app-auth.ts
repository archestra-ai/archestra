import { createHash, createPrivateKey, createPublicKey } from "node:crypto";
import { TimeInMs } from "@archestra/shared";
import { SignJWT } from "jose";
import { LRUCacheManager } from "@/cache-manager";
import { ApiError } from "@/types";
import { parseGitHubAppSecrets } from "./app-secrets";

// credentials needed to mint a short-lived installation token for a GitHub App
type GithubAppCredentials = {
  githubUrl: string;
  appId: string;
  installationId: string;
  privateKey: string;
  minimumValidityMs?: number;
};

/**
 * Resolve GitHub App credentials into a short-lived installation access token.
 * Tokens are cached per (githubUrl, appId, installationId) for just under their
 * one-hour lifetime so repeated calls reuse the same token.
 */
export async function resolveInstallationToken(
  credentials: GithubAppCredentials,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<string> {
  return (await resolveInstallationCredential(credentials, fetchImpl)).token;
}

/** Retain the upstream expiry so workload refresh never guesses token age. */
export async function resolveInstallationCredential(
  credentials: GithubAppCredentials,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<{ token: string; expiresAt: number }> {
  const { githubUrl, appId, installationId } = credentials;
  if (!appId || !installationId || !credentials.privateKey) {
    throw new Error(
      "GitHub App authentication requires app ID, installation ID, and private key",
    );
  }
  const { privateKey } = parseGitHubAppSecrets(credentials.privateKey);

  const cacheKey = buildInstallationTokenCacheKey({
    githubUrl,
    appId,
    installationId,
    privateKey,
  });
  const cachedToken = installationTokenCache.get(cacheKey);
  if (
    cachedToken &&
    cachedToken.expiresAt - Date.now() >
      (credentials.minimumValidityMs ?? 60_000)
  ) {
    return cachedToken;
  }

  const jwt = await signAppJwt({ appId, privateKey });
  const response = await fetchImpl(
    `${githubUrl.replace(/\/+$/, "")}/app/installations/${installationId}/access_tokens`,
    {
      method: "POST",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${jwt}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
      signal: AbortSignal.timeout(INSTALLATION_TOKEN_REQUEST_TIMEOUT_MS),
    },
  );

  if (!response.ok) {
    const responseMessage = await readGithubErrorResponse(response);
    if (response.status === 404) {
      throw new ApiError(
        400,
        "GitHub App or installation was not found. Check the app ID, installation ID, and private key in Settings → Credentials.",
      );
    }
    throw new Error(
      [
        `Failed to create GitHub App installation token: ${response.status} ${response.statusText}`,
        responseMessage,
      ]
        .filter(Boolean)
        .join(": "),
    );
  }

  const body = (await response.json()) as {
    token?: string;
    expires_at?: string;
  };
  if (!body.token) {
    throw new Error(
      "GitHub App installation token response did not include a token",
    );
  }

  const expiresAt = body.expires_at ? Date.parse(body.expires_at) : NaN;
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now())
    throw new Error(
      "GitHub App installation token has an invalid or expired lifetime",
    );
  installationTokenCache.set(
    cacheKey,
    { token: body.token, expiresAt },
    Math.min(GITHUB_APP_INSTALLATION_TOKEN_TTL_MS, expiresAt - Date.now()),
  );
  return { token: body.token, expiresAt };
}

// ===== Internal helpers =====

const GITHUB_APP_INSTALLATION_TOKEN_TTL_MS = 55 * TimeInMs.Minute;
const INSTALLATION_TOKEN_REQUEST_TIMEOUT_MS = 30_000;

const installationTokenCache = new LRUCacheManager<{
  token: string;
  expiresAt: number;
}>({
  maxSize: 500,
  defaultTtl: GITHUB_APP_INSTALLATION_TOKEN_TTL_MS,
});

async function signAppJwt(params: {
  appId: string;
  privateKey: string;
}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const key = createPrivateKey(normalizePrivateKey(params.privateKey));
  return new SignJWT({})
    .setProtectedHeader({ alg: "RS256" })
    .setIssuedAt(now - 60)
    .setExpirationTime(now + 9 * 60)
    .setIssuer(params.appId)
    .sign(key);
}

function buildInstallationTokenCacheKey(params: {
  githubUrl: string;
  appId: string;
  installationId: string;
  privateKey: string;
}): string {
  return [
    params.githubUrl.replace(/\/+$/, ""),
    params.appId,
    params.installationId,
    // The public-key fingerprint invalidates cached tokens when the App key rotates.
    createHash("sha256")
      .update(
        createPublicKey(normalizePrivateKey(params.privateKey)).export({
          type: "spki",
          format: "der",
        }),
      )
      .digest("hex"),
  ].join(":");
}

function normalizePrivateKey(privateKey: string): string {
  return privateKey.replace(/\\n/g, "\n");
}

async function readGithubErrorResponse(response: Response): Promise<string> {
  try {
    const text = await response.text();
    if (!text) return "";

    try {
      const parsed = JSON.parse(text) as { message?: unknown };
      if (typeof parsed.message === "string") {
        return parsed.message;
      }
    } catch {
      // fall back to the raw response body below
    }

    return text.slice(0, 500);
  } catch {
    return "";
  }
}
