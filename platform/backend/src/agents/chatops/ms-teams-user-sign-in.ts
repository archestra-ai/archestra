import { createHash, randomBytes, randomUUID } from "node:crypto";
import { CacheKey, cacheManager } from "@/cache-manager";
import config from "@/config";
import logger from "@/logging";
import { ChatOpsMsTeamsUserConnectionModel } from "@/models";
import {
  MS_TEAMS_SIGN_IN_CALLBACK_PATH,
  MS_TEAMS_SIGN_IN_PATH,
} from "@/routes/route-paths";
import type { IncomingChatMessage } from "@/types/chatops";
import type { MsTeamsUserTokens } from "@/types/chatops-ms-teams-user-connection";
import { isUuid } from "@/utils/uuid";
import { errorMessage } from "./utils";

/**
 * The bot's Entra app, acting as an OAuth client on behalf of a Teams user.
 * Teams keeps a file sent in a group chat in the sender's own OneDrive, which
 * no app-level permission narrower than tenant-wide `Files.Read.All` reaches.
 * Instead each sender signs in once and the bot reads their files with their
 * own delegated `Files.Read`.
 */
export interface MsTeamsOAuthClient {
  tenantId: string;
  clientId: string;
  clientSecret: string;
}

/** Delegated scopes requested at sign-in. `Files.Read` is the user's own files only. */
const MS_TEAMS_USER_SCOPES = [
  "openid",
  "profile",
  "offline_access",
  "https://graph.microsoft.com/Files.Read",
];

/**
 * The exact string to register as a Web redirect URI on the bot's Entra app.
 * Built from the frontend origin: that is where the browser is, and the
 * frontend proxies `/api/*` to the backend.
 */
export function getMsTeamsSignInRedirectUri(): string {
  return `${trimTrailingSlash(config.frontendBaseUrl)}${MS_TEAMS_SIGN_IN_CALLBACK_PATH}`;
}

export type MsTeamsSignInOutcome =
  | { status: "connected"; replay: IncomingChatMessage | null }
  | { status: "expired" }
  | { status: "wrong_account"; expectedName?: string }
  | { status: "failed" };

class MsTeamsUserSignIn {
  /**
   * Hold a message whose files need its sender's sign-in, and return the link
   * that starts it. The link is bound to that sender: the sign-in only counts
   * when the account that finishes it is theirs.
   */
  async createPendingSignIn(params: {
    tenantId: string;
    message: IncomingChatMessage;
  }): Promise<string> {
    const key = randomUUID();
    const pending: PendingSignIn = {
      tenantId: params.tenantId,
      aadObjectId: params.message.senderId,
      senderName: params.message.senderName,
      loginHint: params.message.senderEmail,
      message: serializeMessage(params.message),
    };
    await cacheManager.set(
      `${CacheKey.TeamsFileSignIn}-${key}`,
      pending,
      PENDING_SIGN_IN_TTL_MS,
    );
    const url = new URL(
      MS_TEAMS_SIGN_IN_PATH,
      `${trimTrailingSlash(config.frontendBaseUrl)}/`,
    );
    url.searchParams.set("key", key);
    return url.toString();
  }

  /**
   * The Microsoft sign-in URL for a pending sign-in, or null once it expired.
   * The pending message stays held until the sign-in completes, so a user who
   * abandons Microsoft's page can click the card again.
   */
  async beginSignIn(params: {
    key: string;
    client: MsTeamsOAuthClient;
  }): Promise<string | null> {
    if (!isUuid(params.key)) return null;
    const pending = await cacheManager.get<PendingSignIn>(
      `${CacheKey.TeamsFileSignIn}-${params.key}`,
    );
    if (!pending) return null;

    const state = randomBytes(32).toString("base64url");
    const codeVerifier = randomBytes(48).toString("base64url");
    const signInState: SignInState = { key: params.key, codeVerifier };
    await cacheManager.set(
      `${CacheKey.TeamsFileSignInState}-${state}`,
      signInState,
      SIGN_IN_STATE_TTL_MS,
    );

    const url = new URL(
      `https://login.microsoftonline.com/${encodeURIComponent(params.client.tenantId)}/oauth2/v2.0/authorize`,
    );
    url.searchParams.set("client_id", params.client.clientId);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("redirect_uri", getMsTeamsSignInRedirectUri());
    url.searchParams.set("response_mode", "query");
    url.searchParams.set("scope", MS_TEAMS_USER_SCOPES.join(" "));
    url.searchParams.set("state", state);
    url.searchParams.set("code_challenge", sha256Base64Url(codeVerifier));
    url.searchParams.set("code_challenge_method", "S256");
    if (pending.loginHint) {
      url.searchParams.set("login_hint", pending.loginHint);
    }
    return url.toString();
  }

  /**
   * Finish a sign-in: redeem the code, check that the account is the Teams
   * user the link was made for, and store their tokens. Returns the held
   * message for the caller to answer now that its files are readable.
   */
  async completeSignIn(params: {
    code: string;
    state: string;
    client: MsTeamsOAuthClient;
  }): Promise<MsTeamsSignInOutcome> {
    const signInState = await cacheManager.getAndDelete<SignInState>(
      `${CacheKey.TeamsFileSignInState}-${params.state}`,
    );
    if (!signInState) return { status: "expired" };
    const pendingKey =
      `${CacheKey.TeamsFileSignIn}-${signInState.key}` as const;
    const pending = await cacheManager.get<PendingSignIn>(pendingKey);
    if (!pending) return { status: "expired" };

    let grant: TokenGrant;
    try {
      grant = await requestTokens({
        client: params.client,
        body: {
          grant_type: "authorization_code",
          code: params.code,
          redirect_uri: getMsTeamsSignInRedirectUri(),
          code_verifier: signInState.codeVerifier,
        },
      });
    } catch (error) {
      logger.warn(
        { error: errorMessage(error) },
        "[MSTeamsSignIn] Could not redeem the sign-in code",
      );
      return { status: "failed" };
    }

    // The ID token comes straight from Microsoft's token endpoint over TLS in
    // exchange for the client secret, so its claims need no signature check.
    const claims = decodeJwtClaims(grant.idToken);
    if (
      claims?.tid !== pending.tenantId ||
      claims?.oid !== pending.aadObjectId
    ) {
      logger.warn(
        { expectedTenant: pending.tenantId, signedInTenant: claims?.tid },
        "[MSTeamsSignIn] A different account finished the sign-in; not stored",
      );
      return { status: "wrong_account", expectedName: pending.senderName };
    }

    await ChatOpsMsTeamsUserConnectionModel.save({
      tenantId: pending.tenantId,
      aadObjectId: pending.aadObjectId,
      scope: grant.scope,
      tokens: grant.tokens,
    });
    // Taken once: a second completion of the same link stores the sign-in
    // again but does not answer the message twice.
    const taken = await cacheManager.getAndDelete<PendingSignIn>(pendingKey);
    return {
      status: "connected",
      replay: taken ? deserializeMessage(taken.message) : null,
    };
  }

  /**
   * A current access token for a Teams user who signed in, refreshed when
   * close to expiry. Null when they never signed in, or when Microsoft no
   * longer honours their sign-in (revoked, password reset, consent removed):
   * that connection is dropped so the next file asks them again.
   */
  async getAccessToken(params: {
    tenantId: string;
    aadObjectId: string;
    client: MsTeamsOAuthClient;
  }): Promise<string | null> {
    const connection = await ChatOpsMsTeamsUserConnectionModel.find(params);
    if (!connection) return null;
    const tokens =
      await ChatOpsMsTeamsUserConnectionModel.getTokens(connection);
    if (!tokens) {
      await ChatOpsMsTeamsUserConnectionModel.delete(params);
      return null;
    }
    if (
      tokens.accessTokenExpiresAt - ACCESS_TOKEN_REFRESH_MARGIN_MS >
      Date.now()
    ) {
      return tokens.accessToken;
    }

    try {
      const grant = await requestTokens({
        client: params.client,
        body: {
          grant_type: "refresh_token",
          refresh_token: tokens.refreshToken,
        },
        // Microsoft may leave the refresh token unrotated.
        fallbackRefreshToken: tokens.refreshToken,
      });
      await ChatOpsMsTeamsUserConnectionModel.updateTokens({
        connection,
        tokens: grant.tokens,
      });
      return grant.tokens.accessToken;
    } catch (error) {
      if (error instanceof SignInRevokedError) {
        logger.info(
          { reason: error.message },
          "[MSTeamsSignIn] A Teams user's sign-in is no longer valid; dropping it",
        );
        await ChatOpsMsTeamsUserConnectionModel.delete(params);
      } else {
        logger.warn(
          { error: errorMessage(error) },
          "[MSTeamsSignIn] Could not refresh a Teams user's token",
        );
      }
      return null;
    }
  }

  /** Forget a Teams user's sign-in. Returns whether there was one. */
  async signOut(params: {
    tenantId: string;
    aadObjectId: string;
  }): Promise<boolean> {
    return ChatOpsMsTeamsUserConnectionModel.delete(params);
  }
}

export const msTeamsUserSignIn = new MsTeamsUserSignIn();

// =============================================================================
// Internal Helpers
// =============================================================================

interface PendingSignIn {
  tenantId: string;
  aadObjectId: string;
  senderName: string;
  loginHint?: string;
  message: SerializedMessage;
}

interface SignInState {
  key: string;
  codeVerifier: string;
}

interface TokenGrant {
  tokens: MsTeamsUserTokens;
  scope: string;
  idToken?: string;
}

/** A held message, in the JSON form the shared cache can store. */
type SerializedMessage = Omit<IncomingChatMessage, "timestamp"> & {
  timestamp: string;
};

/** How long a sign-in card can still answer the message it was posted for. */
const PENDING_SIGN_IN_TTL_MS = 60 * 60 * 1000;

/** How long Microsoft's sign-in page may take before its state expires. */
const SIGN_IN_STATE_TTL_MS = 15 * 60 * 1000;

/** Refresh this long before Microsoft's expiry, so a download never races it. */
const ACCESS_TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000;

/**
 * Live objects and request credentials never leave the process: the turn
 * context dies with its webhook, and the auth header is the caller's JWT.
 */
const TRANSIENT_METADATA_KEYS = [
  "turnContext",
  "authHeader",
  "placeholderActivityId",
];

/** Marks the replay of a held message; its Graph id is kept alongside. */
const REPLAY_MESSAGE_SUFFIX = ":signed-in";

class SignInRevokedError extends Error {}

function serializeMessage(message: IncomingChatMessage): SerializedMessage {
  const metadata = Object.fromEntries(
    Object.entries(message.metadata ?? {}).filter(
      ([key]) => !TRANSIENT_METADATA_KEYS.includes(key),
    ),
  );
  return {
    ...message,
    timestamp: message.timestamp.toISOString(),
    metadata,
  };
}

/**
 * The held message as a new message to answer. It gets its own id, so the
 * duplicate check that already claimed the original does not drop it, and it
 * keeps the original as `sourceMessageId` for reading its files from Graph.
 */
function deserializeMessage(message: SerializedMessage): IncomingChatMessage {
  return {
    ...message,
    messageId: `${message.messageId}${REPLAY_MESSAGE_SUFFIX}`,
    timestamp: new Date(message.timestamp),
    metadata: { ...message.metadata, sourceMessageId: message.messageId },
  };
}

async function requestTokens(params: {
  client: MsTeamsOAuthClient;
  body: Record<string, string>;
  fallbackRefreshToken?: string;
}): Promise<TokenGrant> {
  const response = await fetch(
    `https://login.microsoftonline.com/${encodeURIComponent(params.client.tenantId)}/oauth2/v2.0/token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: params.client.clientId,
        client_secret: params.client.clientSecret,
        scope: MS_TEAMS_USER_SCOPES.join(" "),
        ...params.body,
      }),
    },
  );
  const json = (await response.json().catch(() => ({}))) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
    id_token?: string;
    error?: string;
    error_description?: string;
  };
  if (!response.ok || !json.access_token) {
    const reason = json.error ?? `HTTP ${response.status}`;
    // The user must sign in again; anything else may be transient.
    if (reason === "invalid_grant" || reason === "interaction_required") {
      throw new SignInRevokedError(reason);
    }
    throw new Error(`Microsoft token request failed: ${reason}`);
  }
  const refreshToken = json.refresh_token ?? params.fallbackRefreshToken;
  if (!refreshToken) {
    throw new Error("Microsoft returned no refresh token");
  }
  return {
    tokens: {
      accessToken: json.access_token,
      refreshToken,
      accessTokenExpiresAt: Date.now() + (json.expires_in ?? 3600) * 1000,
    },
    scope: json.scope ?? "",
    idToken: json.id_token,
  };
}

function decodeJwtClaims(
  token?: string,
): { tid?: string; oid?: string } | null {
  const payload = token?.split(".")[1];
  if (!payload) return null;
  try {
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

function sha256Base64Url(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}

function trimTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}
