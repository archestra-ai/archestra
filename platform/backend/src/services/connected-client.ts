import { withDbTransaction } from "@/database";
import logger from "@/logging";
import {
  ConnectedClientModel,
  OAuthClientModel,
  SkillShareLinkModel,
} from "@/models";
import {
  ApiError,
  type ConnectedClientId,
  ConnectionSetupClientIdSchema,
} from "@/types";
import { isOAuthClientForConnectClient } from "./connected-client-oauth";
import { dropRevokedSkillShareLinkRepo } from "./skill-share-link";

/**
 * Disconnect one of a user's connected clients on the server side: mark its
 * setups disconnected, revoke the user's gateway OAuth grant for that client
 * and the skill share links its setups created. Local config on the user's
 * machine is removed separately by /disconnect.md.
 *
 * No gateway cache to evict: user-bound token auth results are never cached
 * (see cacheTokenAuthResult in routes/mcp-gateway/utils.ts).
 */
export async function disconnectClient(params: {
  organizationId: string;
  userId: string;
  clientId: ConnectedClientId;
  actorUserId: string;
}): Promise<{
  setups: number;
  oauthClients: number;
  tokens: number;
  consents: number;
  shareLinks: number;
}> {
  const { organizationId, userId, clientId } = params;
  const result = await withDbTransaction(async (tx) => {
    // Agents set up by hand have no setup tickets, only an OAuth grant.
    const setupClientId = ConnectionSetupClientIdSchema.safeParse(clientId);
    const { count: setups, skillShareLinkIds } = setupClientId.success
      ? await ConnectedClientModel.revokeForUser({
          organizationId,
          userId,
          clientId: setupClientId.data,
          revokedByUserId: params.actorUserId,
          tx,
        })
      : { count: 0, skillShareLinkIds: [] };

    const oauthClients = (
      await OAuthClientModel.listWithUserTokens({ userId, tx })
    ).filter((oauthClient) =>
      isOAuthClientForConnectClient(clientId, oauthClient),
    );
    if (setups === 0 && oauthClients.length === 0) {
      throw new ApiError(404, "Connected client not found");
    }
    let tokens = 0;
    let consents = 0;
    for (const oauthClient of oauthClients) {
      const revoked = await OAuthClientModel.revokeUserGrant({
        clientId: oauthClient.clientId,
        userId,
        tx,
      });
      tokens += revoked.tokens;
      consents += revoked.consents;
    }

    const revokedLinkIds: string[] = [];
    for (const id of skillShareLinkIds) {
      if (await SkillShareLinkModel.revoke({ id, organizationId, tx })) {
        revokedLinkIds.push(id);
      }
    }

    return {
      setups,
      oauthClients: oauthClients.length,
      tokens,
      consents,
      revokedLinkIds,
    };
  });
  // As revoking a link on its own does: its materialized repo goes too.
  for (const id of result.revokedLinkIds) dropRevokedSkillShareLinkRepo(id);
  const { revokedLinkIds, ...counts } = result;
  const disconnected = { ...counts, shareLinks: revokedLinkIds.length };

  logger.info(
    {
      organizationId,
      userId,
      clientId,
      actorUserId: params.actorUserId,
      ...disconnected,
    },
    "disconnectClient: connected client disconnected",
  );
  return disconnected;
}
