import ManagedOauthClientModel from "@/models/managed-oauth-client";
import OAuthAccessTokenModel from "@/models/oauth-access-token";

/** Managed client-credentials secrets use the same verifier as token issuance. */
export async function revokeManagedOauthClientAccessToken(params: {
  clientId: unknown;
  clientSecret: unknown;
  token: unknown;
  tokenTypeHint: unknown;
}): Promise<{ statusCode: number; body: Record<string, unknown> } | null> {
  if (typeof params.clientId !== "string") return null;
  const client = await ManagedOauthClientModel.findByClientId(params.clientId);
  // Authorization-code/public clients retain the OAuth provider's verifier.
  if (client?.grantType !== "client_credentials") return null;
  if (typeof params.token !== "string" || !params.token.length) {
    return { statusCode: 400, body: { error: "invalid_request" } };
  }
  if (
    params.tokenTypeHint !== undefined &&
    params.tokenTypeHint !== "access_token" &&
    params.tokenTypeHint !== "refresh_token"
  ) {
    return { statusCode: 400, body: { error: "invalid_request" } };
  }
  const authenticated =
    typeof params.clientSecret === "string" && params.clientSecret.length > 0
      ? await ManagedOauthClientModel.findClientForCredentials({
          clientId: params.clientId,
          clientSecret: params.clientSecret,
        })
      : null;
  if (!authenticated || authenticated.grantType !== "client_credentials") {
    return { statusCode: 401, body: { error: "invalid_client" } };
  }
  // The hint is advisory. Ownership and token kind are checked atomically;
  // unknown/foreign tokens are a non-disclosing no-op. Never affect user or
  // refresh-token families, which retain the existing shield/provider path.
  await OAuthAccessTokenModel.deleteClientCredentialsToken({
    tokenHash: OAuthAccessTokenModel.hashTokenForLookup(params.token),
    clientId: authenticated.clientId,
  });
  return { statusCode: 200, body: {} };
}
