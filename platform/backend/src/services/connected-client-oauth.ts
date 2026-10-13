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
 * Connect client listed in {@link OAUTH_AGENTS}; any other id returns false.
 */
export function isOAuthClientForConnectClient(
  clientId: string,
  oauthClient: OAuthClientIdentity,
): boolean {
  return (
    isOAuthRecognisedClient(clientId) &&
    OAUTH_AGENTS[clientId].identities.some((identity) =>
      matchesIdentity(identity, oauthClient),
    )
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
  const whens = OAUTH_RECOGNISED_CLIENT_IDS.flatMap((id) =>
    OAUTH_AGENTS[id].identities.map((identity: OAuthAgentIdentity) => {
      const tests = [
        identity.clientId !== undefined &&
          sql`${columns.clientId} = ${identity.clientId}`,
        identity.clientIdPattern !== undefined &&
          sql`${columns.clientId} ~ ${identity.clientIdPattern}`,
        identity.clientNamePattern !== undefined &&
          sql`${columns.name} ~ ${identity.clientNamePattern}`,
        identity.redirectUri !== undefined &&
          sql`${identity.redirectUri} = ANY(${columns.redirectUris})`,
      ].filter((test) => test !== false);
      return sql`WHEN ${sql.join(tests, sql` AND `)} THEN ${id}::text`;
    }),
  );
  return sql`CASE ${sql.join(whens, sql` `)} END`;
}

/** The Connect client an OAuth client belongs to, if any. */
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
  return (
    (identity.clientId === undefined ||
      oauthClient.clientId === identity.clientId) &&
    (identity.clientIdPattern === undefined ||
      new RegExp(identity.clientIdPattern).test(oauthClient.clientId)) &&
    (identity.clientNamePattern === undefined ||
      new RegExp(identity.clientNamePattern).test(oauthClient.name ?? "")) &&
    (identity.redirectUri === undefined ||
      oauthClient.redirectUris.includes(identity.redirectUri))
  );
}
