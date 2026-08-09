import type { admin_directory_v1, drive_v3 } from "googleapis";
import { google } from "googleapis";
import type { ConnectorCredentials, GoogleDriveConfig } from "@/types";

/**
 * Read-only Drive access. Every mode asks for exactly this to read files —
 * nothing here ever writes to Drive.
 */
export const DRIVE_READONLY_SCOPE =
  "https://www.googleapis.com/auth/drive.readonly";

/**
 * Directory read access, used only to enumerate the domain's users so each can
 * be impersonated in turn. Requested on the Admin SDK client alone: a
 * service-account token is minted per scope set, so keeping it off the Drive
 * client means a deployment that authorized only Drive still syncs, and an
 * individual connecting their own Drive is never asked to consent to reading
 * the company directory.
 */
export const ADMIN_DIRECTORY_USER_READONLY_SCOPE =
  "https://www.googleapis.com/auth/admin.directory.user.readonly";

/**
 * The identity a Drive client will act as, resolved from the connector's
 * explicit auth mode and the credential it holds.
 *
 * `legacy_*` covers connectors created before auth modes existed. Their config
 * has no `authMode`, so the credential's shape still decides — exactly as it
 * did before — and an upgrade cannot change which identity they sync as.
 */
export type GoogleDriveAuth =
  | { kind: "service_account"; key: ServiceAccountKey; subject?: string }
  | { kind: "oauth"; clientId: string; clientSecret: string; refreshToken: string }
  | { kind: "legacy_access_token"; accessToken: string };

type ServiceAccountKey = Record<string, unknown>;

/**
 * A service-account identity that is definitely impersonating someone — the
 * only shape that can read the directory or swap to another user mid-pass.
 */
export type DelegatedServiceAccountAuth = Extract<
  GoogleDriveAuth,
  { kind: "service_account" }
> & { subject: string };

export function asDelegatedAuth(
  auth: GoogleDriveAuth,
): DelegatedServiceAccountAuth {
  if (auth.kind !== "service_account" || !auth.subject) {
    throw new GoogleDriveAuthConfigError(
      "A domain-wide sync requires a service account with domain-wide delegation and an admin email to impersonate.",
    );
  }
  return auth as DelegatedServiceAccountAuth;
}

/**
 * Thrown when a connector cannot even be turned into an authenticated client —
 * a missing key, an unconnected OAuth connector, a delegated setup with no
 * admin to impersonate. Separate from an API rejection so callers can tell
 * "this is misconfigured" from "Google said no".
 */
export class GoogleDriveAuthConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GoogleDriveAuthConfigError";
  }
}

/**
 * Resolve which identity to act as. `impersonate` overrides the configured
 * delegated admin, which is how the domain-wide pass walks one user at a time
 * through the same code path.
 */
export function resolveGoogleDriveAuth(params: {
  config: GoogleDriveConfig;
  credentials: ConnectorCredentials;
  impersonate?: string;
}): GoogleDriveAuth {
  const { config, credentials, impersonate } = params;

  switch (config.authMode) {
    case "oauth": {
      const oauth = credentials.googleOAuth;
      // Checked before the client credentials: a connector that was never
      // authorized has no stored OAuth data at all, and "connect an account"
      // is the useful thing to say about it — not that a client is missing.
      if (!oauth?.refreshToken) {
        throw new GoogleDriveAuthConfigError(
          "This connector has not been connected to a Google account yet. Open the connector and choose Connect Google account.",
        );
      }
      if (!oauth.clientId || !oauth.clientSecret) {
        throw new GoogleDriveAuthConfigError(
          "This deployment has no Google OAuth client configured, so a connector in individual mode cannot authenticate. Set ARCHESTRA_KNOWLEDGE_BASE_GOOGLE_DRIVE_OAUTH_CLIENT_ID and ARCHESTRA_KNOWLEDGE_BASE_GOOGLE_DRIVE_OAUTH_CLIENT_SECRET.",
        );
      }
      return {
        kind: "oauth",
        clientId: oauth.clientId,
        clientSecret: oauth.clientSecret,
        refreshToken: oauth.refreshToken,
      };
    }

    case "service_account_delegated": {
      const subject = impersonate ?? config.delegatedAdminEmail;
      if (!subject) {
        throw new GoogleDriveAuthConfigError(
          "Domain-wide delegation needs a delegated admin email to impersonate.",
        );
      }
      return {
        kind: "service_account",
        key: parseServiceAccountKey(credentials.apiToken),
        subject,
      };
    }

    case "service_account":
      return {
        kind: "service_account",
        key: parseServiceAccountKey(credentials.apiToken),
      };

    default: {
      // No explicit mode: a pre-auth-mode connector. Keep inferring from the
      // credential's shape so it authenticates exactly as it always has.
      const key = tryParseServiceAccountKey(credentials.apiToken);
      if (key) return { kind: "service_account", key };
      if (!credentials.apiToken) {
        throw new GoogleDriveAuthConfigError(
          "This connector has no Google Drive credential.",
        );
      }
      return { kind: "legacy_access_token", accessToken: credentials.apiToken };
    }
  }
}

export function buildDriveClient(auth: GoogleDriveAuth): drive_v3.Drive {
  return google.drive({ version: "v3", auth: buildAuthClient(auth) });
}

/**
 * Admin SDK client for enumerating the domain's users. Only a delegated
 * service account can build one: impersonation is what makes a directory read
 * possible at all.
 */
export function buildAdminDirectoryClient(
  auth: GoogleDriveAuth,
): admin_directory_v1.Admin {
  if (auth.kind !== "service_account" || !auth.subject) {
    throw new GoogleDriveAuthConfigError(
      "Reading the Workspace directory requires a service account with domain-wide delegation.",
    );
  }
  const client = new google.auth.GoogleAuth({
    credentials: auth.key,
    scopes: [ADMIN_DIRECTORY_USER_READONLY_SCOPE],
    clientOptions: { subject: auth.subject },
  });
  return google.admin({ version: "directory_v1", auth: client });
}

/**
 * Turn a Google failure into something an admin can act on.
 *
 * Google reports every delegation and consent problem as the same handful of
 * opaque OAuth codes, so the raw message ("unauthorized_client") tells an
 * operator nothing about which console they have to open. `subject` is the
 * identity that was being impersonated, when there was one.
 */
export function describeGoogleAuthFailure(params: {
  error: unknown;
  subject?: string;
}): string | null {
  const { error, subject } = params;
  const raw = rawErrorText(error).toLowerCase();
  const who = subject ? ` as ${subject}` : "";

  if (raw.includes("unauthorized_client")) {
    return `Google refused to impersonate${who}: the service account's client ID is not authorized for the requested scopes. Add it under Security → Access and data control → API controls → Domain-wide delegation in the Google Admin console, with the scope ${DRIVE_READONLY_SCOPE}.`;
  }
  if (raw.includes("invalid_grant")) {
    return subject
      ? `Google rejected the impersonation of ${subject}. That address must be an active user in the same Workspace domain as the delegated client.`
      : "Google rejected the stored authorization — the refresh token was revoked, expired, or belongs to a different OAuth client. Reconnect the Google account.";
  }
  if (raw.includes("invalid_client")) {
    return "Google rejected the OAuth client credentials. Check the configured client ID and secret, then reconnect the Google account.";
  }
  if (
    raw.includes("accessnotconfigured") ||
    raw.includes("has not been used in project") ||
    raw.includes("is disabled")
  ) {
    return "The required Google API is not enabled on the Cloud project behind these credentials. Enable the Google Drive API (and the Admin SDK API for domain-wide delegation), then retry.";
  }
  if (raw.includes("insufficient") && raw.includes("scope")) {
    return `The credential is missing a required scope. Drive access needs ${DRIVE_READONLY_SCOPE}${subject ? `, and enumerating the domain needs ${ADMIN_DIRECTORY_USER_READONLY_SCOPE}` : ""}.`;
  }
  return null;
}

// ===== Internal helpers =====

function buildAuthClient(auth: GoogleDriveAuth) {
  switch (auth.kind) {
    case "service_account":
      return new google.auth.GoogleAuth({
        credentials: auth.key,
        scopes: [DRIVE_READONLY_SCOPE],
        // Domain-wide delegation: the token is minted for this user rather
        // than for the service account itself.
        ...(auth.subject ? { clientOptions: { subject: auth.subject } } : {}),
      });

    case "oauth": {
      const client = new google.auth.OAuth2(auth.clientId, auth.clientSecret);
      // Only the refresh token is set: google-auth-library mints an access
      // token on the first call and again whenever the current one expires, so
      // a long sync cannot die halfway through on an expired token.
      client.setCredentials({ refresh_token: auth.refreshToken });
      return client;
    }

    case "legacy_access_token": {
      const client = new google.auth.OAuth2();
      client.setCredentials({ access_token: auth.accessToken });
      return client;
    }
  }
}

function parseServiceAccountKey(apiToken: string): ServiceAccountKey {
  const key = tryParseServiceAccountKey(apiToken);
  if (!key) {
    throw new GoogleDriveAuthConfigError(
      "This auth mode needs a service account JSON key. Paste the whole key file, including its private_key field.",
    );
  }
  return key;
}

function tryParseServiceAccountKey(
  apiToken: string,
): ServiceAccountKey | null {
  if (!apiToken.trim().startsWith("{")) return null;
  try {
    const parsed = JSON.parse(apiToken) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    return parsed as ServiceAccountKey;
  } catch {
    return null;
  }
}

/**
 * Everything an error might be carrying, flattened to one searchable string:
 * google-auth-library puts the OAuth code in different places depending on
 * whether the token endpoint or an API call rejected the request.
 */
function rawErrorText(error: unknown): string {
  if (error === null || error === undefined) return "";
  if (typeof error === "string") return error;
  const parts: string[] = [];
  if (error instanceof Error) {
    parts.push(error.message);
  }
  if (typeof error === "object") {
    const candidate = error as {
      message?: unknown;
      response?: { data?: unknown };
      errors?: unknown;
    };
    if (typeof candidate.message === "string") parts.push(candidate.message);
    if (candidate.response?.data !== undefined) {
      parts.push(safeStringify(candidate.response.data));
    }
    if (candidate.errors !== undefined) parts.push(safeStringify(candidate.errors));
  }
  return parts.join(" ");
}

function safeStringify(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}
