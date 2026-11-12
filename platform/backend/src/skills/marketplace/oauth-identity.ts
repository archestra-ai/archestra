import { MCP_GATEWAY_OAUTH_SCOPE } from "@archestra/shared/oauth";
import ManagedOauthClientModel from "@/models/managed-oauth-client";
import OAuthAccessTokenModel from "@/models/oauth-access-token";
import OAuthClientModel from "@/models/oauth-client";
import UserModel from "@/models/user";

/** Resolve a browser user's MCP grant without widening a bound token's audience. */
export async function resolveMarketplaceOAuthIdentity(credential: string) {
  const token = await OAuthAccessTokenModel.getByTokenHash(
    OAuthAccessTokenModel.hashTokenForLookup(credential),
  );
  if (
    !token?.userId ||
    token.referenceId ||
    token.refreshTokenRevoked ||
    token.expiresAt <= new Date() ||
    !token.scopes?.includes(MCP_GATEWAY_OAUTH_SCOPE)
  )
    return null;

  // Check every client, including DCR/CIMD clients. Internal issuers have
  // disabled clients with no authorization-code grant and must stay excluded.
  const client = await OAuthClientModel.findByClientId(token.clientId);
  if (
    !client ||
    client.disabled ||
    client.serviceAccountId ||
    !client.grantTypes?.includes("authorization_code") ||
    (client.scopes && !client.scopes.includes(MCP_GATEWAY_OAUTH_SCOPE))
  )
    return null;

  // getById joins the user's current membership, like personal credentials.
  const user = await UserModel.getById(token.userId);
  if (!user?.organizationId) return null;

  const managedClient = await ManagedOauthClientModel.findByClientId(
    token.clientId,
  );
  if (
    managedClient &&
    (managedClient.organizationId !== user.organizationId ||
      !managedClient.scopes.includes(MCP_GATEWAY_OAUTH_SCOPE))
  )
    return null;

  return { userId: user.id, organizationId: user.organizationId };
}
