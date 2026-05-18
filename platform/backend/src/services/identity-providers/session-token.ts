import { OAUTH_TOKEN_TYPE, type OAuthTokenType } from "@shared";
import { jwtDecode } from "jwt-decode";
import logger from "@/logging";
import { AccountModel, AgentModel } from "@/models";
import { refreshLinkedIdentityProviderAccessToken } from "@/services/identity-providers/access-token-refresh";
import { findExternalIdentityProviderById } from "@/services/identity-providers/oidc";

interface SessionExternalIdpToken {
  identityProviderId: string;
  providerId: string;
  rawToken: string;
}

type SubjectTokenPreference = "access_token" | "id_token";

export async function resolveSessionExternalIdpToken(params: {
  agentId?: string;
  identityProviderId?: string;
  userId: string;
}): Promise<SessionExternalIdpToken | null> {
  const identityProviderId =
    params.identityProviderId ??
    (params.agentId
      ? (await AgentModel.findById(params.agentId))?.identityProviderId
      : null);
  if (!identityProviderId) {
    return null;
  }

  const identityProvider =
    await findExternalIdentityProviderById(identityProviderId);
  if (!identityProvider?.oidcConfig) {
    return null;
  }

  const account = await AccountModel.getLatestSsoAccountByUserIdAndProviderId(
    params.userId,
    identityProvider.providerId,
  );
  const tokenPreference = resolveSubjectTokenPreference(identityProvider);
  const rawToken =
    tokenPreference === "access_token"
      ? account?.accessToken
      : account?.idToken;
  if (!rawToken) {
    return null;
  }

  if (isStoredSubjectTokenExpired({ account, tokenPreference, rawToken })) {
    if (tokenPreference === "access_token") {
      const refreshedAccessToken =
        await refreshLinkedIdentityProviderAccessToken({
          account: {
            id: account.id,
            providerId: account.providerId,
            refreshToken: account.refreshToken,
            refreshTokenExpiresAt: account.refreshTokenExpiresAt,
          },
        });

      if (refreshedAccessToken) {
        return {
          identityProviderId: identityProvider.id,
          providerId: identityProvider.providerId,
          rawToken: refreshedAccessToken,
        };
      }
    }
  }

  if (isStoredSubjectTokenExpired({ account, tokenPreference, rawToken })) {
    logger.info(
      {
        agentId: params.agentId,
        userId: params.userId,
        identityProviderId: identityProvider.id,
        providerId: identityProvider.providerId,
        tokenPreference,
      },
      "Session external IdP token is expired; falling back to internal gateway auth",
    );
    return null;
  }

  return {
    identityProviderId: identityProvider.id,
    providerId: identityProvider.providerId,
    rawToken,
  };
}

// =============================================================================
// Internal helpers
// =============================================================================

function isJwtExpired(token: string): boolean {
  try {
    const payload = jwtDecode<{ exp?: number }>(token);
    if (!payload.exp) {
      return true;
    }
    return payload.exp <= Math.floor(Date.now() / 1000);
  } catch {
    return true;
  }
}

function resolveSubjectTokenPreference(identityProvider: {
  oidcConfig?: {
    enterpriseManagedCredentials?: {
      subjectTokenType?: string;
      exchangeStrategy?: string;
    };
  } | null;
}): SubjectTokenPreference {
  const subjectTokenType = parseEnterpriseSubjectTokenType(
    identityProvider.oidcConfig?.enterpriseManagedCredentials?.subjectTokenType,
  );
  if (subjectTokenType === OAUTH_TOKEN_TYPE.AccessToken) {
    return "access_token";
  }
  if (subjectTokenType === OAUTH_TOKEN_TYPE.IdToken) {
    return "id_token";
  }

  if (
    identityProvider.oidcConfig?.enterpriseManagedCredentials
      ?.exchangeStrategy === "rfc8693" ||
    identityProvider.oidcConfig?.enterpriseManagedCredentials
      ?.exchangeStrategy === "entra_obo"
  ) {
    return "access_token";
  }

  return "id_token";
}

function parseEnterpriseSubjectTokenType(
  value: string | undefined,
): OAuthTokenType | null {
  if (value === OAUTH_TOKEN_TYPE.AccessToken) {
    return OAUTH_TOKEN_TYPE.AccessToken;
  }
  if (value === OAUTH_TOKEN_TYPE.IdToken) {
    return OAUTH_TOKEN_TYPE.IdToken;
  }
  return null;
}

function isStoredSubjectTokenExpired(params: {
  account: {
    accessTokenExpiresAt: Date | null;
  };
  tokenPreference: SubjectTokenPreference;
  rawToken: string;
}): boolean {
  if (params.tokenPreference === "access_token") {
    if (params.account.accessTokenExpiresAt) {
      return params.account.accessTokenExpiresAt <= new Date();
    }
    return true;
  }

  return isJwtExpired(params.rawToken);
}
