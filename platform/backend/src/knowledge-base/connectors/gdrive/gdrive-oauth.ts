import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { google } from "googleapis";
import config from "@/config";
import { GOOGLE_DRIVE_OAUTH_CALLBACK_PATH } from "@/routes/route-paths";
import { DRIVE_READONLY_SCOPE } from "./gdrive-auth";

/** How long an authorization may sit half-finished before its state expires. */
const STATE_TTL_MS = 15 * 60 * 1000;

const HMAC_DOMAIN = "archestra:gdrive-oauth-state:v1";

export interface GoogleDriveOAuthState {
  connectorId: string;
  userId: string;
  organizationId: string;
  returnTo: string;
}

/**
 * The exact string to register as an authorized redirect URI on the Google
 * OAuth client. Built from the frontend origin, not the API origin: that is
 * where the browser is, and the frontend proxies `/api/*` through to the
 * backend, so one public origin serves both.
 */
export function getGoogleDriveOAuthRedirectUri(): string {
  return `${trimTrailingSlash(config.frontendBaseUrl)}${GOOGLE_DRIVE_OAUTH_CALLBACK_PATH}`;
}

export function isGoogleDriveOAuthConfigured(): boolean {
  const { clientId, clientSecret } = config.kb.googleDriveOAuth;
  return Boolean(clientId && clientSecret);
}

/**
 * Google client credentials, or null when the deployment has not configured
 * them. Callers surface the variable names rather than failing opaquely.
 */
export function getGoogleDriveOAuthClient(): {
  clientId: string;
  clientSecret: string;
} | null {
  const { clientId, clientSecret } = config.kb.googleDriveOAuth;
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret };
}

export function buildGoogleDriveAuthorizationUrl(
  state: GoogleDriveOAuthState,
): string {
  const client = getGoogleDriveOAuthClient();
  if (!client) {
    throw new Error(
      "No Google OAuth client is configured on this deployment. Set ARCHESTRA_KNOWLEDGE_BASE_GOOGLE_DRIVE_OAUTH_CLIENT_ID and ARCHESTRA_KNOWLEDGE_BASE_GOOGLE_DRIVE_OAUTH_CLIENT_SECRET.",
    );
  }

  const oauth2 = new google.auth.OAuth2(
    client.clientId,
    client.clientSecret,
    getGoogleDriveOAuthRedirectUri(),
  );

  return oauth2.generateAuthUrl({
    // A refresh token is the whole point — without offline access the
    // connector would stop syncing an hour after it was set up.
    access_type: "offline",
    // Google only returns a refresh token on the FIRST authorization for a
    // client/account pair unless consent is re-prompted. Reconnecting an
    // account that already granted access is exactly the case that would
    // otherwise come back with no refresh token at all.
    prompt: "consent",
    scope: [DRIVE_READONLY_SCOPE],
    state: signGoogleDriveOAuthState(state),
  });
}

/**
 * Exchange the authorization code and read back which account authorized it.
 *
 * The account email comes from Drive's own `about.get`, so no profile scope
 * has to be requested just to label the connection.
 */
export async function exchangeGoogleDriveAuthorizationCode(code: string): Promise<{
  refreshToken: string;
  clientId: string;
  accountEmail: string | null;
}> {
  const client = getGoogleDriveOAuthClient();
  if (!client) {
    throw new Error("No Google OAuth client is configured on this deployment.");
  }

  const oauth2 = new google.auth.OAuth2(
    client.clientId,
    client.clientSecret,
    getGoogleDriveOAuthRedirectUri(),
  );

  const { tokens } = await oauth2.getToken(code);
  if (!tokens.refresh_token) {
    throw new Error(
      "Google did not return a refresh token. Remove Archestra from the account's third-party access at myaccount.google.com/permissions and connect again.",
    );
  }

  oauth2.setCredentials(tokens);
  let accountEmail: string | null = null;
  try {
    const drive = google.drive({ version: "v3", auth: oauth2 });
    const about = await drive.about.get({ fields: "user(emailAddress)" });
    accountEmail = about.data.user?.emailAddress ?? null;
  } catch {
    // Only the display label is lost; the authorization itself succeeded and
    // must not be thrown away over it.
  }

  return {
    refreshToken: tokens.refresh_token,
    clientId: client.clientId,
    accountEmail,
  };
}

export function signGoogleDriveOAuthState(state: GoogleDriveOAuthState): string {
  const payload = {
    ...state,
    nonce: randomBytes(16).toString("base64url"),
    exp: Date.now() + STATE_TTL_MS,
  };
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${encoded}.${sign(encoded)}`;
}

/**
 * Verify and decode a state parameter. Returns null for anything that is not
 * a currently-valid state this deployment issued — a forged, tampered,
 * malformed, or expired value all fail the same way, so the callback can
 * refuse without telling a prober which it was.
 */
export function verifyGoogleDriveOAuthState(
  raw: string,
): GoogleDriveOAuthState | null {
  const separator = raw.lastIndexOf(".");
  if (separator <= 0) return null;

  const encoded = raw.slice(0, separator);
  const signature = raw.slice(separator + 1);
  if (!verifySignature(encoded, signature)) return null;

  try {
    const decoded = JSON.parse(
      Buffer.from(encoded, "base64url").toString("utf-8"),
    ) as Partial<GoogleDriveOAuthState> & { exp?: number };

    if (typeof decoded.exp !== "number" || decoded.exp < Date.now()) {
      return null;
    }
    if (
      typeof decoded.connectorId !== "string" ||
      typeof decoded.userId !== "string" ||
      typeof decoded.organizationId !== "string" ||
      typeof decoded.returnTo !== "string"
    ) {
      return null;
    }

    return {
      connectorId: decoded.connectorId,
      userId: decoded.userId,
      organizationId: decoded.organizationId,
      returnTo: decoded.returnTo,
    };
  } catch {
    return null;
  }
}

/**
 * Confine the post-authorization redirect to this deployment's own frontend.
 * The value survives a round trip through Google inside signed state, but it
 * still originates from a request parameter — an unchecked one would turn the
 * callback into an open redirect.
 */
export function resolveGoogleDriveOAuthReturnTo(
  candidate: string | undefined,
  fallbackPath = "/knowledge",
): string {
  const base = trimTrailingSlash(config.frontendBaseUrl);
  const fallback = `${base}${fallbackPath}`;
  if (!candidate) return fallback;

  try {
    const resolved = new URL(candidate, base);
    return resolved.origin === new URL(base).origin ? resolved.toString() : fallback;
  } catch {
    return fallback;
  }
}

// ===== Internal helpers =====

/**
 * Derived from the session-signing secret so an existing deployment needs no
 * new configuration, and domain-separated so a state token can never be
 * mistaken for another HMAC this secret protects.
 */
function hmacKey(): string | null {
  const secret = config.auth.secret;
  if (!secret) return null;
  return createHmac("sha256", secret).update(HMAC_DOMAIN).digest("hex");
}

function sign(encoded: string): string {
  const key = hmacKey();
  if (!key) {
    throw new Error(
      "Cannot sign the Google Drive OAuth state: no auth secret is configured",
    );
  }
  return createHmac("sha256", key).update(encoded).digest("base64url");
}

function verifySignature(encoded: string, signature: string): boolean {
  const key = hmacKey();
  if (!key) return false;

  const expected = createHmac("sha256", key).update(encoded).digest("base64url");
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  // timingSafeEqual throws on a length mismatch, and comparing equal-length
  // buffers keeps the check constant-time.
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}
