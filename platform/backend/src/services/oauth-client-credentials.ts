import { randomBytes } from "node:crypto";
import {
  LLM_OAUTH_CLIENT_CREDENTIALS_ACCESS_TOKEN_LIFETIME_SECONDS,
  OAUTH_CLIENT_REFERENCE_PREFIX,
} from "@archestra/shared";
import { requestedOauthClientScopes } from "@/auth/oauth-client-scopes";
import ManagedOauthClientModel from "@/models/managed-oauth-client";
import OAuthAccessTokenModel from "@/models/oauth-access-token";

export async function issueManagedOauthClientAccessToken(params: {
  clientId?: string;
  clientSecret?: string;
  scope?: string;
}): Promise<{
  ok: boolean;
  statusCode: number;
  body: Record<string, unknown>;
}> {
  const invalidClient = {
    ok: false,
    statusCode: 401,
    body: { error: "invalid_client" },
  };
  if (!params.clientId || !params.clientSecret) return invalidClient;
  const client = await ManagedOauthClientModel.findClientForCredentials({
    clientId: params.clientId,
    clientSecret: params.clientSecret,
  });
  if (!client || client.grantType !== "client_credentials")
    return invalidClient;
  const scopes = requestedOauthClientScopes({
    granted: client.scopes,
    requested: params.scope,
  });
  if (!scopes)
    return {
      ok: false,
      statusCode: 400,
      body: {
        error: "invalid_scope",
        error_description: "Request only scopes granted to this OAuth client",
      },
    };
  const tokenPrefix = client.clientId.startsWith("mcp_oauth_")
    ? "mcp_at_"
    : client.clientId.startsWith("llm_oauth_")
      ? "llm_at_"
      : "oauth_at_";
  const accessToken = `${tokenPrefix}${randomBytes(32).toString("base64url")}`;
  const expiresIn = LLM_OAUTH_CLIENT_CREDENTIALS_ACCESS_TOKEN_LIFETIME_SECONDS;
  await OAuthAccessTokenModel.createClientCredentialsToken({
    tokenHash: OAuthAccessTokenModel.hashTokenForLookup(accessToken),
    clientId: client.clientId,
    expiresAt: new Date(Date.now() + expiresIn * 1000),
    scopes,
    referenceId: `${OAUTH_CLIENT_REFERENCE_PREFIX}${client.id}`,
  });
  return {
    ok: true,
    statusCode: 200,
    body: {
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: expiresIn,
      scope: scopes.join(" "),
    },
  };
}
