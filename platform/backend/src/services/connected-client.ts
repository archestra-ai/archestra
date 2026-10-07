import { OAUTH_RECOGNISED_CLIENT_IDS } from "@archestra/shared/connection-setup";
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
  type ConnectedClientRecord,
  ConnectionSetupClientIdSchema,
} from "@/types";
import { isOAuthClientForConnectClient } from "./connected-client-oauth";
import { dropRevokedSkillShareLinkRepo } from "./skill-share-link";

/** Traffic is read this far back, as on the Agent connections tab. */
const LAST_SEEN_DAYS = 30;

/**
 * The user's connected clients, most recently connected first: redeemed
 * setups, plus agents the gateway can tell apart by their OAuth client while
 * the user holds an unexpired token for one, set up by hand or not. Merged
 * with a setup entry, the earliest connect is kept as the first and the
 * latest as the last. A sign-in counts as a connect once, when it was first
 * consented to: token refreshes happen on every launch and are not connects.
 * Each client carries when its gateway or LLM proxy traffic was last seen.
 */
export async function listConnectedClients(params: {
  organizationId: string;
  userId: string;
}): Promise<ConnectedClientRecord[]> {
  const [redeemed, oauthClients, adoption] = await Promise.all([
    ConnectedClientModel.listRedeemedForUser(params),
    OAuthClientModel.listWithUserTokens({
      userId: params.userId,
      activeOnly: true,
    }),
    ConnectedClientModel.getAdoption({
      organizationId: params.organizationId,
      userId: params.userId,
      lookbackDays: LAST_SEEN_DAYS,
    }),
  ]);
  // Newest gateway or LLM proxy call per Connect client.
  const member = adoption.members[0];
  const lastSeen = new Map<string, Date>();
  for (const use of [
    ...(member?.gatewayUses ?? []),
    ...(member?.llmUses ?? []),
  ]) {
    const { clientId } = use.agent;
    if (!clientId) continue;
    const prev = lastSeen.get(clientId);
    if (!prev || use.lastSeenAt > prev) lastSeen.set(clientId, use.lastSeenAt);
  }
  const byClient = new Map(redeemed.map((c) => [c.clientId, c]));
  for (const clientId of OAUTH_RECOGNISED_CLIENT_IDS) {
    const matches = oauthClients.filter((c) =>
      isOAuthClientForConnectClient(clientId, c),
    );
    if (matches.length === 0) continue;
    const first = Math.min(...matches.map((c) => c.firstIssuedAt.getTime()));
    const consents = matches.flatMap((c) =>
      c.consentedAt ? [c.consentedAt.getTime()] : [],
    );
    const signedIn = consents.length > 0 ? Math.max(...consents) : first;
    const client = byClient.get(clientId);
    if (client) {
      if (first < client.connectedAt.getTime())
        client.connectedAt = new Date(first);
      if (signedIn > client.lastConnectedAt.getTime())
        client.lastConnectedAt = new Date(signedIn);
      continue;
    }
    byClient.set(clientId, {
      clientId,
      platform: null,
      mcpGatewayId: null,
      llmProxyId: null,
      connectedAt: new Date(Math.min(first, signedIn)),
      lastConnectedAt: new Date(signedIn),
      deviceNames: [],
      lastSeenAt: null,
    });
  }
  for (const client of byClient.values()) {
    client.lastSeenAt = lastSeen.get(client.clientId) ?? null;
  }
  return [...byClient.values()].sort(
    (a, b) => b.lastConnectedAt.getTime() - a.lastConnectedAt.getTime(),
  );
}

/** Audit snapshot of one user's connected client; null when not connected. */
export async function findConnectedClientForAudit(params: {
  organizationId: string;
  userId: string;
  clientId: string;
}): Promise<Record<string, unknown> | null> {
  const clients = await listConnectedClients(params);
  const client = clients.find((c) => c.clientId === params.clientId);
  return client ? { userId: params.userId, ...client } : null;
}

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
