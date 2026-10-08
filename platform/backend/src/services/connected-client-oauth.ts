import {
  isOAuthRecognisedClient,
  OAUTH_AGENTS,
  OAUTH_RECOGNISED_CLIENT_IDS,
  type OAuthAgentId,
  type OAuthAgentIdentity,
} from "@archestra/shared/connection-setup";
import { type SQL, sql } from "drizzle-orm";

interface OAuthClientIdentity {
  clientId: string;
  name: string | null;
  redirectUris: string[];
}

/**
 * Whether an OAuth client (the gateway's `oauth_client` row) belongs to a
 * Connect client listed in {@link OAUTH_AGENTS}. Only stable, verified
 * identities match; any other id returns false.
 */
export function isOAuthClientForConnectClient(
  clientId: string,
  oauthClient: OAuthClientIdentity,
): boolean {
  return (
    isOAuthRecognisedClient(clientId) &&
    matchesIdentity(OAUTH_AGENTS[clientId].identity, oauthClient)
  );
}

/**
 * {@link connectClientForOAuthClient} in SQL, over an `oauth_client` row's
 * columns: the Connect client id, or NULL.
 */
export function connectClientForOAuthClientSql(columns: {
  clientId: SQL;
  name: SQL;
  redirectUris: SQL;
}): SQL {
  const whens = OAUTH_RECOGNISED_CLIENT_IDS.map((id) => {
    const identity: OAuthAgentIdentity = OAUTH_AGENTS[id].identity;
    const test =
      "clientId" in identity
        ? sql`${columns.clientId} = ${identity.clientId}`
        : "clientIdPattern" in identity
          ? sql`${columns.clientId} ~ ${identity.clientIdPattern}`
          : sql`${columns.name} ~ ${identity.clientNamePattern}
            AND ${identity.redirectUri} = ANY(${columns.redirectUris})`;
    return sql`WHEN ${test} THEN ${id}::text`;
  });
  return sql`CASE ${sql.join(whens, sql` `)} END`;
}

/** The Connect client an OAuth client verifiably belongs to, if any. */
export function connectClientForOAuthClient(
  oauthClient: OAuthClientIdentity,
): OAuthAgentId | null {
  return (
    OAUTH_RECOGNISED_CLIENT_IDS.find((id) =>
      isOAuthClientForConnectClient(id, oauthClient),
    ) ?? null
  );
}

function matchesIdentity(
  identity: OAuthAgentIdentity,
  oauthClient: OAuthClientIdentity,
): boolean {
  if ("clientId" in identity) return oauthClient.clientId === identity.clientId;
  if ("clientIdPattern" in identity)
    return new RegExp(identity.clientIdPattern).test(oauthClient.clientId);
  return (
    new RegExp(identity.clientNamePattern).test(oauthClient.name ?? "") &&
    oauthClient.redirectUris.includes(identity.redirectUri)
  );
}
