/**
 * GitHub App credentials for GitHub Copilot.
 *
 * An organization can let a GitHub App (organization permission "Copilot
 * Requests") call Copilot on its behalf, billed to the organization. The key
 * stores the App ID, installation ID, private key, GitHub address and
 * organization as one marker-encoded value. Installation tokens (`ghs_…`)
 * come from the shared GitHub App helpers and are sent to Copilot as a Bearer
 * with the Copilot runtime's integration id.
 */
import { createHash, createPrivateKey, createPublicKey } from "node:crypto";
import {
  GITHUB_APP_CREDENTIAL_MARKER,
  getGithubApiBaseUrl,
} from "@archestra/shared";
import config from "@/config";
import { LRUCacheManager } from "@/in-memory-lru-cache";
import {
  fetchAsGithubApp,
  resolveInstallationCredential,
} from "@/integrations/github/app-auth";
import logger from "@/logging";
import { ApiError } from "@/types/api";

export interface GithubAppCredential {
  appId: string;
  installationId: string;
  privateKey: string;
  /** GitHub web address. Absent on preview keys: https://github.com. */
  githubUrl?: string;
  /** Login of the organization the App is installed on. */
  organization?: string;
}

const DEFAULT_GITHUB_URL = "https://github.com";

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
      ...(typeof parsed.githubUrl === "string"
        ? { githubUrl: parsed.githubUrl }
        : {}),
      ...(typeof parsed.organization === "string"
        ? { organization: parsed.organization }
        : {}),
    };
  } catch {
    return null;
  }
}

/**
 * Check a pasted App ID and private key. Throws a 400 naming the bad field;
 * never echoes the private key.
 */
export function validateGithubAppPrivateKey(params: {
  appId: string;
  privateKey: string;
}): { appId: string; privateKey: string; fingerprint: string } {
  const appId = params.appId.trim();
  if (!/^\d+$/.test(appId)) {
    throw new ApiError(400, "GitHub App ID must be a number.");
  }
  const privateKey = `${params.privateKey.trim()}\n`;
  return {
    appId,
    privateKey,
    fingerprint: githubAppKeyFingerprint(privateKey),
  };
}

/**
 * The private key's fingerprint as GitHub shows it on the App settings page:
 * `SHA256:` + base64 of the SHA-256 of the public key (DER, SPKI).
 *
 * @public — exercised directly by unit tests (GitHub's fingerprint format)
 */
export function githubAppKeyFingerprint(privateKey: string): string {
  let der: Buffer;
  try {
    const key = createPrivateKey(privateKey);
    if (key.asymmetricKeyType !== "rsa") throw new Error("not rsa");
    der = createPublicKey(key).export({ type: "spki", format: "der" });
  } catch {
    throw new ApiError(
      400,
      "GitHub App private key must be the RSA PEM file downloaded from the App settings.",
    );
  }
  return `SHA256:${createHash("sha256").update(der).digest("base64")}`;
}

/** The REST API base for a credential's GitHub. */
function githubAppApiBase(credential: GithubAppCredential): string {
  return getGithubApiBaseUrl(credential.githubUrl ?? DEFAULT_GITHUB_URL);
}

/**
 * A valid installation token. `forceRefresh` mints a new one even when a
 * cached token is still valid (Copilot rejected it early).
 */
export async function getGithubAppInstallationToken(
  credential: GithubAppCredential,
  options?: { forceRefresh?: boolean },
): Promise<string> {
  const { token } = await resolveInstallationCredential({
    githubUrl: githubAppApiBase(credential),
    appId: credential.appId,
    installationId: credential.installationId,
    privateKey: credential.privateKey,
    minimumValidityMs: options?.forceRefresh
      ? Number.POSITIVE_INFINITY
      : REFRESH_BUFFER_MS,
  });
  return token;
}

/** The Copilot-Integration-Id sent with installation tokens. */
export function copilotAppIntegrationId(): string {
  return (
    config.llm["github-copilot"].appIntegrationId?.trim() ||
    // The Copilot runtime's default Copilot-Integration-Id, as named in
    // GitHub's Copilot SDK docs (docs/setup/multi-tenancy.md); GitHub says
    // that runtime works with installation tokens.
    "copilot-developer-cli"
  );
}

/**
 * The organization the App is installed on: from the credential, else looked
 * up once from GitHub (keys made before the organization was stored).
 */
export async function githubAppOrganization(
  credential: GithubAppCredential,
): Promise<string | null> {
  if (credential.organization) return credential.organization;
  const cacheKey = `${credential.githubUrl ?? DEFAULT_GITHUB_URL}:${credential.appId}:${credential.installationId}`;
  const cached = organizationCache.get(cacheKey);
  if (cached !== undefined) return cached;
  try {
    const installation = await fetchAsGithubApp<{
      account: { login: string } | null;
    }>({
      githubUrl: githubAppApiBase(credential),
      appId: credential.appId,
      privateKey: credential.privateKey,
      path: `/app/installations/${encodeURIComponent(credential.installationId)}`,
    });
    const login = installation.account?.login ?? null;
    organizationCache.set(cacheKey, login);
    return login;
  } catch (error) {
    logger.info(
      { appId: credential.appId, error: (error as Error).message },
      "[GithubAppCopilot] could not look up the App's organization",
    );
    return null;
  }
}

/**
 * Turn Copilot's rejection of an installation token into a message that says
 * what to fix, quoting GitHub's own words.
 */
export function copilotAppErrorMessage(params: {
  status: number;
  githubMessage: string;
  organization?: string | null;
}): string {
  const { status, githubMessage } = params;
  const org = params.organization ?? "the organization";
  const quoted = githubMessage ? ` GitHub said: "${githubMessage}"` : "";
  if (/integration[- ]id/i.test(githubMessage))
    return `GitHub Copilot rejected the integration id. Unset ARCHESTRA_GITHUB_COPILOT_APP_INTEGRATION_ID or set it to the value GitHub expects.${quoted}`;
  if (status === 403 && /not enabled|policy|app/i.test(githubMessage))
    return `${org} doesn't allow Copilot requests from GitHub Apps. An owner can turn this on in the organization's Copilot policies (needs Copilot Business or Enterprise).${quoted}`;
  if (status === 403)
    return `The App can't make Copilot requests. Check that it has the Copilot Requests permission and that ${org} approved it.${quoted}`;
  return `GitHub Copilot answered ${status}.${quoted}`;
}

// ===== Internal helpers =====

/** Re-mint an installation token this long before its expiry. */
const REFRESH_BUFFER_MS = 5 * 60 * 1000;

const organizationCache = new LRUCacheManager<string | null>({
  maxSize: 200,
  defaultTtl: 60 * 60 * 1000,
});
