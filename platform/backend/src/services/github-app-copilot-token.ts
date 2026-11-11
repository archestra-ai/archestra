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
  TimeInMs,
} from "@archestra/shared";
import { LRUCacheManager } from "@/in-memory-lru-cache";
import { resolveInstallationCredential } from "@/integrations/github/app-auth";
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
 * The plan's App credential is gone: its definition was deleted or its
 * private key disconnected. Definitive, so the plan needs a reconnect.
 */
export class GithubAppCredentialGoneError extends ApiError {
  constructor() {
    super(
      400,
      "The GitHub App credential this plan uses was deleted or disconnected. Reconnect it.",
    );
  }
}

/**
 * A value that is no usable plan reference: not a reference, or one that
 * points at another organization's credential. Refused without reading any
 * credential, and never a reason to flag a key.
 */
export class GithubAppReferenceError extends ApiError {
  constructor(message: string) {
    super(400, message);
  }
}

/**
 * The App a plan key signs in as, read from the GitHub App credential its
 * stored reference names. Only a reference into `organizationId` (the stored
 * key's own organization) is honored. A failing credential or secret store
 * read is thrown as it is: it says nothing about the App.
 */
export async function resolveGithubAppCredential(params: {
  value: string | null | undefined;
  organizationId: string;
}): Promise<GithubAppCredential> {
  const reference = decodeGithubAppReference(params.value);
  if (!reference)
    throw new GithubAppReferenceError(
      "The stored value is not a GitHub App reference.",
    );
  if (reference.ref.organizationId !== params.organizationId)
    throw new GithubAppReferenceError(
      "The GitHub App reference belongs to another organization.",
    );
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
    if (definition?.kind !== "github_app" || !definition.appId)
      throw new GithubAppCredentialGoneError();
    const privateKey = await connections.resolveValue({
      organizationId: reference.ref.organizationId,
      credentialId: definition.key,
      scope: "organization",
    });
    if (!privateKey) throw new GithubAppCredentialGoneError();
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

/**
 * The name GitHub shows for the organization a plan is installed on
 * ("Archestra" for the login `archestra-ai`), or null when it has none or
 * GitHub doesn't say. Read with the plan's App, so an organization of managed
 * users or on a private Enterprise Server answers too; without a working App
 * (a plan to reconnect), a public organization still answers anonymously.
 *
 * Cached per installation. A caller waits on GitHub a few seconds at most and
 * then gets null; the lookup goes on and fills the cache for the next read.
 */
export async function githubOrganizationDisplayName(params: {
  value: string | null | undefined;
  organizationId: string;
}): Promise<string | null> {
  const reference = decodeGithubAppReference(params.value);
  if (!reference || reference.ref.organizationId !== params.organizationId)
    return null;
  const cacheKey = [
    reference.ref.organizationId,
    reference.ref.credentialId,
    reference.installationId,
    reference.organization,
  ].join(":");
  const cached = organizationNameCache.get(cacheKey);
  if (cached) return cached.name;
  let lookup = organizationNameLookups.get(cacheKey);
  if (!lookup) {
    lookup = readOrganizationName({
      value: params.value,
      organizationId: params.organizationId,
      reference,
    })
      .then(
        (name) => {
          organizationNameCache.set(cacheKey, { name });
          return name;
        },
        (error: unknown) => {
          // Not worth a warning: the plan shows its login meanwhile.
          logger.info(
            { err: error, organization: reference.organization },
            "[GithubAppCopilot] could not read the organization's name from GitHub",
          );
          organizationNameCache.set(
            cacheKey,
            { name: null },
            ORGANIZATION_NAME_RETRY_MS,
          );
          return null;
        },
      )
      .finally(() => organizationNameLookups.delete(cacheKey));
    organizationNameLookups.set(cacheKey, lookup);
  }
  return withDeadline(lookup, ORGANIZATION_NAME_WAIT_MS);
}

/** The web address of a credential's GitHub API base. */
export function githubWebFromApi(api: string | null | undefined): string {
  return getGithubWebOrigin(api ?? "https://api.github.com");
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

/**
 * The Copilot-Integration-Id sent with installation tokens: the Copilot
 * runtime's own id, as named in GitHub's Copilot SDK docs
 * (docs/setup/multi-tenancy.md); GitHub says that runtime works with
 * installation tokens.
 */
export const COPILOT_APP_INTEGRATION_ID = "copilot-developer-cli";

/** Why Copilot refused an App's request, when it says so plainly. */
type CopilotAppRejection =
  | "integration_id"
  | "missing_permission"
  | "apps_disabled";

/**
 * Name Copilot's refusal of the App itself, from GitHub's own message. A
 * refusal of one request (a model the policy blocks, a bad payload) is none
 * of these and returns null.
 */
export function classifyCopilotAppRejection(params: {
  status: number;
  githubMessage: string;
}): CopilotAppRejection | null {
  const { status, githubMessage: message } = params;
  if (
    (status === 400 || status === 403) &&
    /integration[- ]id|installation access token/i.test(message)
  )
    return "integration_id";
  if (status !== 403) return null;
  if (
    /resource not accessible by integration|copilot[ _]requests permission|organization_copilot_requests/i.test(
      message,
    )
  )
    return "missing_permission";
  if (
    /\b(github apps?|app installations?|integrations?)\b[^.]*\b(not allowed|not permitted|not enabled|disabled|blocked)\b|\bcopilot\b[^.]*\b(disabled|not enabled)\b[^.]*\bfor (github )?apps?\b/i.test(
      message,
    )
  )
    return "apps_disabled";
  return null;
}

/**
 * A message for a refusal, saying what to fix and quoting GitHub's words.
 * Without a named reason it only quotes GitHub.
 */
export function copilotAppErrorMessage(params: {
  rejection: CopilotAppRejection | null;
  status: number;
  githubMessage: string;
  organization?: string | null;
}): string {
  const org = params.organization ?? "the organization";
  const quoted = params.githubMessage
    ? ` GitHub said: "${params.githubMessage}"`
    : "";
  switch (params.rejection) {
    case "integration_id":
      return `GitHub Copilot rejected the integration id.${quoted}`;
    case "missing_permission":
      return `The App can't make Copilot requests. Check that it has the Copilot Requests permission and that ${org} approved it.${quoted}`;
    case "apps_disabled":
      return `${org} doesn't allow Copilot requests from GitHub Apps. It needs Copilot Business or Enterprise, with requests from Apps allowed by an owner of the organization or its enterprise.${quoted}`;
    default:
      return `GitHub Copilot answered ${params.status}.${quoted}`;
  }
}

// ===== Internal helpers =====

/**
 * `GET /orgs/{org}`, as the plan's App when it can still sign in, otherwise
 * anonymously.
 */
async function readOrganizationName(params: {
  value: string | null | undefined;
  organizationId: string;
  reference: GithubAppCredentialReference;
}): Promise<string | null> {
  const token = await resolveGithubAppCredential(params)
    .then((credential) => getGithubAppInstallationToken(credential))
    .catch(() => null);
  const response = await fetch(
    `${githubAppApiBase(params.reference)}/orgs/${encodeURIComponent(params.reference.organization)}`,
    {
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      redirect: "error",
      signal: AbortSignal.timeout(ORGANIZATION_NAME_REQUEST_TIMEOUT_MS),
    },
  );
  if (!response.ok) throw new Error(`GitHub returned HTTP ${response.status}`);
  const { name } = (await response.json()) as { name?: unknown };
  return typeof name === "string" && name.trim() ? name.trim() : null;
}

/** The promise's value, or null once `ms` pass first. */
async function withDeadline<T>(
  promise: Promise<T>,
  ms: number,
): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
    timer.unref?.();
  });
  try {
    return await Promise.race([promise, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/** Organization names, per installation. GitHub rarely sees them change. */
const organizationNameCache = new LRUCacheManager<{ name: string | null }>({
  maxSize: 1000,
  defaultTtl: TimeInMs.Hour,
});
/** Lookups in flight, so a list of one organization's plans asks GitHub once. */
const organizationNameLookups = new Map<string, Promise<string | null>>();
/** A failed lookup is retried after this long. */
const ORGANIZATION_NAME_RETRY_MS = 5 * TimeInMs.Minute;
/** The longest a key list waits on GitHub for a name. */
const ORGANIZATION_NAME_WAIT_MS = 3_000;
const ORGANIZATION_NAME_REQUEST_TIMEOUT_MS = 15_000;

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
