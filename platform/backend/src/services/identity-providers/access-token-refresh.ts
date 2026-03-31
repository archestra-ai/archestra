import logger from "@/logging";
import AccountModel from "@/models/account";
import {
  discoverOidcTokenEndpoint,
  findExternalIdentityProviderByProviderId,
} from "@/services/identity-providers/oidc";

export async function refreshLinkedIdentityProviderAccessToken(params: {
  account: {
    id: string;
    providerId: string;
    refreshToken: string | null;
    refreshTokenExpiresAt: Date | null;
  };
}): Promise<string | undefined> {
  if (!params.account.refreshToken) {
    return undefined;
  }

  if (
    params.account.refreshTokenExpiresAt &&
    params.account.refreshTokenExpiresAt <= new Date()
  ) {
    return undefined;
  }

  const identityProvider = await findExternalIdentityProviderByProviderId(
    params.account.providerId,
  );
  if (!identityProvider?.oidcConfig?.clientId) {
    return undefined;
  }

  const tokenEndpoint =
    identityProvider.oidcConfig.tokenEndpoint ??
    (await discoverOidcTokenEndpoint(identityProvider.issuer));
  if (!tokenEndpoint) {
    return undefined;
  }

  const authMethod =
    identityProvider.oidcConfig.tokenEndpointAuthentication ??
    "client_secret_post";
  if (
    authMethod === "private_key_jwt" ||
    (authMethod !== "client_secret_post" &&
      authMethod !== "client_secret_basic")
  ) {
    logger.warn(
      {
        providerId: params.account.providerId,
        authMethod,
      },
      "Skipping linked identity-provider token refresh because the token endpoint authentication method is not supported",
    );
    return undefined;
  }

  const headers = new Headers({
    Accept: "application/json",
    "Content-Type": "application/x-www-form-urlencoded",
  });
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: params.account.refreshToken,
  });

  if (authMethod === "client_secret_basic") {
    const clientSecret = identityProvider.oidcConfig.clientSecret;
    if (!clientSecret) {
      return undefined;
    }
    const basicAuth = Buffer.from(
      `${identityProvider.oidcConfig.clientId}:${clientSecret}`,
    ).toString("base64");
    headers.set("Authorization", `Basic ${basicAuth}`);
  } else {
    body.set("client_id", identityProvider.oidcConfig.clientId);
    if (identityProvider.oidcConfig.clientSecret) {
      body.set("client_secret", identityProvider.oidcConfig.clientSecret);
    }
  }

  const response = await fetch(tokenEndpoint, {
    method: "POST",
    headers,
    body,
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    logger.warn(
      {
        providerId: params.account.providerId,
        status: response.status,
      },
      "Linked identity-provider token refresh failed",
    );
    return undefined;
  }

  const tokenData = (await response.json()) as {
    access_token?: string;
    refresh_token?: string;
    id_token?: string;
    expires_in?: number;
    refresh_expires_in?: number;
  };
  if (!tokenData.access_token) {
    return undefined;
  }

  await AccountModel.updateTokens({
    id: params.account.id,
    accessToken: tokenData.access_token,
    refreshToken: tokenData.refresh_token ?? params.account.refreshToken,
    idToken: tokenData.id_token,
    accessTokenExpiresAt:
      tokenData.expires_in !== undefined
        ? new Date(Date.now() + tokenData.expires_in * 1000)
        : undefined,
    refreshTokenExpiresAt:
      tokenData.refresh_expires_in !== undefined
        ? new Date(Date.now() + tokenData.refresh_expires_in * 1000)
        : undefined,
  });

  logger.info(
    { providerId: params.account.providerId },
    "Refreshed linked identity-provider access token",
  );

  return tokenData.access_token;
}
