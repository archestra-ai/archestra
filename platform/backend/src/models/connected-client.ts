import type { PaginationQuery } from "@archestra/shared";
import {
  and,
  count,
  countDistinct,
  desc,
  eq,
  gte,
  inArray,
  isNotNull,
  isNull,
  max,
  min,
  sql,
} from "drizzle-orm";
import db, { schema, type Transaction } from "@/database";
import {
  createPaginatedResult,
  type PaginatedResult,
} from "@/database/utils/pagination";
import {
  isOAuthClientForConnectClient,
  OAUTH_RECOGNISED_CLIENT_IDS,
} from "@/services/connected-client-oauth";
import {
  type ConnectedClient,
  type ConnectedClientId,
  type ConnectedUser,
  type ConnectionSetupClientId,
  GATEWAY_CAPABLE_AGENT_TYPES,
} from "@/types";
import OAuthClientModel from "./oauth-client";

/** How far back the admin list counts gateway and LLM proxy use. */
const CONNECTED_USAGE_WINDOW_DAYS = 30;

const setups = schema.connectionSetupsTable;

/**
 * Read-only views over data Archestra already keeps about connected clients.
 * A client counts as connected once its setup ticket is redeemed
 * (`consumedAt`) and until it is disconnected (`revokedAt`); tickets are
 * never purged, so they double as the history.
 */
class ConnectedClientModel {
  /** The user's connected clients, most recently connected first. */
  static async listForUser(params: {
    organizationId: string;
    userId: string;
  }): Promise<ConnectedClient[]> {
    const rows = await db
      .select({
        clientId: setups.clientId,
        platform: setups.platform,
        mcpGatewayId: setups.mcpGatewayId,
        llmProxyId: setups.llmProxyId,
        consumedAt: setups.consumedAt,
        deviceName: setups.deviceName,
      })
      .from(setups)
      .where(
        and(
          eq(setups.organizationId, params.organizationId),
          eq(setups.userId, params.userId),
          isNotNull(setups.consumedAt),
          isNull(setups.revokedAt),
        ),
      )
      .orderBy(desc(setups.consumedAt));

    // Newest first, so the first row per client carries its current setup.
    const byClient = new Map<ConnectedClientId, ConnectedClient>();
    for (const { consumedAt, deviceName, ...row } of rows) {
      if (!consumedAt) continue;
      let client = byClient.get(row.clientId);
      if (client) {
        client.connectedAt = consumedAt;
      } else {
        client = {
          ...row,
          connectedAt: consumedAt,
          lastConnectedAt: consumedAt,
          deviceNames: [],
        };
        byClient.set(row.clientId, client);
      }
      if (deviceName && !client.deviceNames.includes(deviceName)) {
        client.deviceNames.push(deviceName);
      }
    }

    // Agents the gateway can tell apart by their OAuth client count as
    // connected while the user holds a token for one, set up by hand or not.
    // These are the same rows a disconnect revokes.
    const oauthClients = await OAuthClientModel.listWithUserTokens({
      userId: params.userId,
    });
    for (const clientId of OAUTH_RECOGNISED_CLIENT_IDS) {
      const matches = oauthClients.filter((c) =>
        isOAuthClientForConnectClient(clientId, c),
      );
      if (matches.length === 0) continue;
      const first = Math.min(...matches.map((c) => c.firstIssuedAt.getTime()));
      const last = Math.max(...matches.map((c) => c.lastIssuedAt.getTime()));
      const client = byClient.get(clientId);
      if (client) {
        // Latest connect wins, whichever way it happened.
        if (first < client.connectedAt.getTime())
          client.connectedAt = new Date(first);
        if (last > client.lastConnectedAt.getTime())
          client.lastConnectedAt = new Date(last);
        continue;
      }
      byClient.set(clientId, {
        clientId,
        platform: null,
        mcpGatewayId: null,
        llmProxyId: null,
        connectedAt: new Date(first),
        lastConnectedAt: new Date(last),
        deviceNames: [],
      });
    }
    return [...byClient.values()].sort(
      (a, b) => b.lastConnectedAt.getTime() - a.lastConnectedAt.getTime(),
    );
  }

  /** Audit snapshot of one user's connected client; null when not connected. */
  static async findForAudit(params: {
    organizationId: string;
    userId: string;
    clientId: string;
  }): Promise<Record<string, unknown> | null> {
    const clients = await ConnectedClientModel.listForUser(params);
    const client = clients.find((c) => c.clientId === params.clientId);
    return client ? { userId: params.userId, ...client } : null;
  }

  /**
   * Mark the user's redeemed setups for one client as disconnected, so the
   * client drops out of both lists. Returns the stamped setups' skill share
   * link ids (for revocation) and how many setups changed.
   */
  static async revokeForUser(params: {
    organizationId: string;
    userId: string;
    clientId: ConnectionSetupClientId;
    revokedByUserId: string;
    tx: Transaction;
  }): Promise<{ count: number; skillShareLinkIds: string[] }> {
    const rows = await params.tx
      .update(setups)
      .set({ revokedAt: new Date(), revokedByUserId: params.revokedByUserId })
      .where(
        and(
          eq(setups.organizationId, params.organizationId),
          eq(setups.userId, params.userId),
          eq(setups.clientId, params.clientId),
          isNotNull(setups.consumedAt),
          isNull(setups.revokedAt),
        ),
      )
      .returning({ skillShareLinkId: setups.skillShareLinkId });
    return {
      count: rows.length,
      skillShareLinkIds: rows.flatMap((r) =>
        r.skillShareLinkId ? [r.skillShareLinkId] : [],
      ),
    };
  }

  /**
   * Members who connected at least one client, most recently connected first,
   * with their gateway and LLM proxy use over the last
   * {@link CONNECTED_USAGE_WINDOW_DAYS} days. Usage is aggregated only for the
   * page's users, so large tool-call and interaction tables are read through
   * their user_id indexes for a bounded set.
   */
  static async listConnectedUsers(
    params: { organizationId: string } & PaginationQuery,
  ): Promise<PaginatedResult<ConnectedUser>> {
    const { organizationId, limit, offset } = params;
    const redeemed = and(
      eq(setups.organizationId, organizationId),
      isNotNull(setups.consumedAt),
      isNull(setups.revokedAt),
    );

    const lastConnectedAt = max(setups.consumedAt);
    const [users, [{ total }]] = await Promise.all([
      db
        .select({
          userId: setups.userId,
          name: schema.usersTable.name,
          email: schema.usersTable.email,
          clientIds: sql<
            ConnectionSetupClientId[]
          >`array_agg(distinct ${setups.clientId} order by ${setups.clientId})`,
          firstConnectedAt: min(setups.consumedAt),
          lastConnectedAt,
        })
        .from(setups)
        .innerJoin(schema.usersTable, eq(setups.userId, schema.usersTable.id))
        .where(redeemed)
        .groupBy(setups.userId, schema.usersTable.name, schema.usersTable.email)
        .orderBy(desc(lastConnectedAt), setups.userId)
        .limit(limit)
        .offset(offset),
      db
        .select({ total: countDistinct(setups.userId) })
        .from(setups)
        .where(redeemed),
    ]);

    const userIds = users.map((user) => user.userId);
    const since = new Date(
      Date.now() - CONNECTED_USAGE_WINDOW_DAYS * 24 * 60 * 60 * 1000,
    );
    const [gatewayUse, llmUse] = await Promise.all([
      getGatewayUse({ organizationId, userIds, since }),
      getLlmUse({ organizationId, userIds, since }),
    ]);

    const data = users.map((user) => {
      const gateway = gatewayUse.get(user.userId);
      const llm = llmUse.get(user.userId);
      return {
        ...user,
        firstConnectedAt: user.firstConnectedAt as Date,
        lastConnectedAt: user.lastConnectedAt as Date,
        lastGatewayCallAt: gateway?.lastAt ?? null,
        gatewayCallCount: gateway?.count ?? 0,
        lastLlmRequestAt: llm?.lastAt ?? null,
        llmRequestCount: llm?.count ?? 0,
      };
    });

    return createPaginatedResult(data, Number(total), { limit, offset });
  }
}

export default ConnectedClientModel;

// === Internal helpers

type UsageByUser = Map<string, { lastAt: Date; count: number }>;

async function getGatewayUse(params: {
  organizationId: string;
  userIds: string[];
  since: Date;
}): Promise<UsageByUser> {
  if (params.userIds.length === 0) return new Map();
  const calls = schema.mcpToolCallsTable;
  const rows = await db
    .select({
      userId: calls.userId,
      lastAt: max(calls.createdAt),
      count: count(),
    })
    .from(calls)
    .innerJoin(schema.agentsTable, eq(calls.agentId, schema.agentsTable.id))
    .where(
      and(
        inArray(calls.userId, params.userIds),
        gte(calls.createdAt, params.since),
        eq(schema.agentsTable.organizationId, params.organizationId),
        inArray(schema.agentsTable.agentType, [...GATEWAY_CAPABLE_AGENT_TYPES]),
      ),
    )
    .groupBy(calls.userId);
  return toUsageMap(rows);
}

async function getLlmUse(params: {
  organizationId: string;
  userIds: string[];
  since: Date;
}): Promise<UsageByUser> {
  if (params.userIds.length === 0) return new Map();
  const interactions = schema.interactionsTable;
  const rows = await db
    .select({
      userId: interactions.userId,
      lastAt: max(interactions.createdAt),
      count: count(),
    })
    .from(interactions)
    .innerJoin(
      schema.agentsTable,
      eq(interactions.profileId, schema.agentsTable.id),
    )
    .where(
      and(
        inArray(interactions.userId, params.userIds),
        gte(interactions.createdAt, params.since),
        eq(schema.agentsTable.organizationId, params.organizationId),
        eq(schema.agentsTable.agentType, "llm_proxy"),
      ),
    )
    .groupBy(interactions.userId);
  return toUsageMap(rows);
}

function toUsageMap(
  rows: { userId: string | null; lastAt: Date | null; count: number }[],
): UsageByUser {
  const usage: UsageByUser = new Map();
  for (const row of rows) {
    if (row.userId && row.lastAt) {
      usage.set(row.userId, { lastAt: row.lastAt, count: Number(row.count) });
    }
  }
  return usage;
}
