/**
 * GitHub App credentials for GitHub Copilot.
 *
 * An organization can let a GitHub App (organization permission "Copilot
 * Requests") call Copilot on its behalf, billed to the organization. The key
 * stores a marker-encoded reference to the App's GitHub App credential (one
 * of the organization's runtime credentials) and its installation on the
 * organization. Installation tokens (`ghs_…`) come from the shared GitHub App
 * helpers and are sent to Copilot as a Bearer with the Copilot runtime's
 * integration id.
 */
import { createHash, createPrivateKey, createPublicKey } from "node:crypto";
import {
  GITHUB_APP_CREDENTIAL_MARKER,
  getGithubApiBaseUrl,
  getGithubWebOrigin,
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
  /** GitHub web address. Absent means https://github.com. */
  githubUrl?: string;
  /** Login of the organization the App is installed on. */
  organization?: string;
}

/**
 * A key's pointer to a GitHub App credential: the App and its private key live
 * there, shared with every other use of the App. The installation is the
 * App's installation on this organization.
 */
interface GithubAppCredentialReference {
  ref: { organizationId: string; credentialId: string };
  installationId: string;
  organization: string;
  /** GitHub web address. */
  githubUrl: string;
}

const DEFAULT_GITHUB_URL = "https://github.com";

export function encodeGithubAppReference(
  reference: GithubAppCredentialReference,
): string {
  return `${GITHUB_APP_CREDENTIAL_MARKER}${Buffer.from(JSON.stringify(reference), "utf8").toString("base64url")}`;
}

/** The reference a key's value holds, or null for an embedded or other value. */
export function decodeGithubAppReference(
  value: string | null | undefined,
): GithubAppCredentialReference | null {
  if (!value || !value.startsWith(GITHUB_APP_CREDENTIAL_MARKER)) return null;
  try {
    const parsed = JSON.parse(
      Buffer.from(
        value.slice(GITHUB_APP_CREDENTIAL_MARKER.length),
        "base64url",
      ).toString("utf8"),
    ) as Partial<GithubAppCredentialReference>;
    if (
      typeof parsed.ref?.organizationId !== "string" ||
      typeof parsed.ref?.credentialId !== "string" ||
      typeof parsed.installationId !== "string" ||
      typeof parsed.organization !== "string" ||
      typeof parsed.githubUrl !== "string"
    )
      return null;
    return {
      ref: {
        organizationId: parsed.ref.organizationId,
        credentialId: parsed.ref.credentialId,
      },
      installationId: parsed.installationId,
      organization: parsed.organization,
      githubUrl: parsed.githubUrl,
    };
  } catch {
    return null;
  }
}

/**
 * The App a key's value signs in as: read from the referenced GitHub App
 * credential, or embedded in the value (the in-memory form used to read a new
 * App's models before it is saved). Null for a value that is no
 * GitHub App marker. Throws a 400 when the referenced credential or its
 * connection is gone, which the fetch path turns into a reconnect.
 */
export async function resolveGithubAppCredential(
  value: string | null | undefined,
): Promise<GithubAppCredential | null> {
  const reference = decodeGithubAppReference(value);
  if (!reference) return decodeGithubAppCredential(value);
  const cacheKey = `${reference.ref.organizationId}:${reference.ref.credentialId}`;
  let app = referenceCache.get(cacheKey);
  if (!app) {
    const [{ default: definitions }, { default: connections }] =
      await Promise.all([
        import("@/models/runtime-credential-definition"),
        import("@/models/runtime-credential-connection"),
      ]);
    const definition = await definitions.findById({
      id: reference.ref.credentialId,
      organizationId: reference.ref.organizationId,
    });
    const privateKey =
      definition?.kind === "github_app" && definition.appId
        ? await connections
            .resolveValue({
              organizationId: reference.ref.organizationId,
              credentialId: definition.key,
              scope: "organization",
            })
            .catch(() => null)
        : null;
    if (!definition?.appId || !privateKey)
      throw new ApiError(
        400,
        "The GitHub App credential this subscription uses was deleted or disconnected. Reconnect it.",
      );
    app = { appId: definition.appId, privateKey, name: definition.name };
    referenceCache.set(cacheKey, app);
  }
  return {
    appId: app.appId,
    privateKey: app.privateKey,
    installationId: reference.installationId,
    organization: reference.organization,
    githubUrl: reference.githubUrl,
  };
}

/** Forget a resolved reference, after its credential changed. */
export function forgetGithubAppReference(reference: {
  organizationId: string;
  credentialId: string;
}) {
  referenceCache.delete(
    `${reference.organizationId}:${reference.credentialId}`,
  );
}

/** The web address of a credential's GitHub API base. */
export function githubWebFromApi(api: string | null | undefined): string {
  return getGithubWebOrigin(api ?? "https://api.github.com");
}

export function encodeGithubAppCredential(
  credential: GithubAppCredential,
): string {
  const json = JSON.stringify(credential);
  return `${GITHUB_APP_CREDENTIAL_MARKER}${Buffer.from(json, "utf8").toString("base64url")}`;
}

/** @public — exercised directly by unit tests (the marker format) */
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
    // A stored App credential holds the PEM with its OAuth client secret.
    const pem = privateKey.trimStart().startsWith("{")
      ? (JSON.parse(privateKey) as { privateKey: string }).privateKey
      : privateKey;
    const key = createPrivateKey(pem);
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
export function githubAppApiBase(credential: { githubUrl?: string }): string {
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

/**
 * Resolved references, briefly: a request does not read the credential store
 * each time, and a deleted credential stops working within this long.
 */
const referenceCache = new LRUCacheManager<{
  appId: string;
  privateKey: string;
  name: string;
}>({
  maxSize: 200,
  defaultTtl: 30 * 1000,
});
