import { withDbTransaction } from "@/database";
import logger from "@/logging";
import {
  ConnectedClientModel,
  OAuthAccessTokenModel,
  OAuthClientModel,
  OAuthRefreshTokenModel,
  SkillShareLinkModel,
} from "@/models";
import {
  ApiError,
  type ConnectedClientId,
  ConnectionSetupClientIdSchema,
} from "@/types";
import { isOAuthClientForConnectClient } from "./connected-client-oauth";

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
    for (const oauthClient of oauthClients) {
      // Access rows first: their refresh_id FK is ON DELETE SET NULL.
      tokens += await OAuthAccessTokenModel.deleteByClientAndUser({
        clientId: oauthClient.clientId,
        userId,
        tx,
      });
      const refreshRows = await OAuthRefreshTokenModel.listByClientAndUser({
        clientId: oauthClient.clientId,
        userId,
        tx,
      });
      tokens += await OAuthRefreshTokenModel.deleteByIds(
        refreshRows.map((row) => row.id),
        tx,
      );
    }

    let shareLinks = 0;
    for (const id of skillShareLinkIds) {
      if (await SkillShareLinkModel.revoke({ id, organizationId, tx })) {
        shareLinks++;
      }
    }

    return { setups, oauthClients: oauthClients.length, tokens, shareLinks };
  });

  logger.info(
    {
      organizationId,
      userId,
      clientId,
      actorUserId: params.actorUserId,
      ...result,
    },
    "disconnectClient: connected client disconnected",
  );
  return result;
}
