import type { PaginationQuery } from "@archestra/shared";
import {
  and,
  count,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  max,
  sql,
} from "drizzle-orm";
import db, { schema, type Transaction } from "@/database";
import {
  createPaginatedResult,
  type PaginatedResult,
} from "@/database/utils/pagination";
import { buildTokenizedSearchFilter } from "@/database/utils/text-search";
import type {
  ConnectedClientRecord,
  ConnectionSetupClientId,
  MemberConnectionStatus,
} from "@/types";

const setups = schema.connectionSetupsTable;

/**
 * Read-only views over data Archestra already keeps about connected clients.
 * A client counts as connected once its setup ticket is redeemed
 * (`consumedAt`) and until it is disconnected (`revokedAt`); tickets are
 * never purged, so they double as the history.
 */
class ConnectedClientModel {
  /**
   * The user's redeemed, not revoked setups, one entry per client. Gateway
   * sign-ins are merged in by services/connected-client.ts.
   */
  static async listRedeemedForUser(params: {
    organizationId: string;
    userId: string;
  }): Promise<ConnectedClientRecord[]> {
    const byUser = await ConnectedClientModel.listRedeemedForUsers({
      organizationId: params.organizationId,
      userIds: [params.userId],
    });
    return byUser.get(params.userId) ?? [];
  }

  /**
   * {@link listRedeemedForUser} for several users at once, keyed by user id;
   * users with no redeemed setup are absent. Clients are most recently
   * connected first.
   */
  static async listRedeemedForUsers(params: {
    organizationId: string;
    userIds: string[];
  }): Promise<Map<string, ConnectedClientRecord[]>> {
    const result = new Map<string, ConnectedClientRecord[]>();
    if (params.userIds.length === 0) return result;
    const rows = await db
      .select({
        userId: setups.userId,
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
          inArray(setups.userId, params.userIds),
          isNotNull(setups.consumedAt),
          isNull(setups.revokedAt),
        ),
      )
      .orderBy(desc(setups.consumedAt));

    // Newest first, so the first row per client carries its current setup.
    const byClient = new Map<string, ConnectedClientRecord>();
    for (const { userId, consumedAt, deviceName, ...row } of rows) {
      if (!consumedAt) continue;
      const key = `${userId}:${row.clientId}`;
      let client = byClient.get(key);
      if (client) {
        client.connectedAt = consumedAt;
      } else {
        client = {
          ...row,
          connectedAt: consumedAt,
          lastConnectedAt: consumedAt,
          deviceNames: [],
        };
        byClient.set(key, client);
        const clients = result.get(userId) ?? [];
        clients.push(client);
        result.set(userId, clients);
      }
      if (deviceName && !client.deviceNames.includes(deviceName)) {
        client.deviceNames.push(deviceName);
      }
    }

    return result;
  }

  /**
   * One page of the organization's members with when each last connected an
   * agent (null for never), most recent first and never-connected last, plus
   * how many members there are and how many have connected. Search and
   * status narrow the page, not the counts.
   */
  static async listMembersWithLastConnect(params: {
    organizationId: string;
    pagination: PaginationQuery;
    name?: string;
    status?: MemberConnectionStatus;
  }): Promise<{
    page: PaginatedResult<{
      userId: string;
      name: string;
      email: string;
      image: string | null;
      lastConnectedAt: Date | null;
    }>;
    memberCount: number;
    connectedCount: number;
  }> {
    const { organizationId, pagination, name, status } = params;
    const members = schema.membersTable;
    const users = schema.usersTable;
    const lastConnect = db
      .select({
        userId: setups.userId,
        lastConnectedAt: max(setups.consumedAt).as("last_connected_at"),
      })
      .from(setups)
      .where(
        and(
          eq(setups.organizationId, organizationId),
          isNotNull(setups.consumedAt),
          isNull(setups.revokedAt),
        ),
      )
      .groupBy(setups.userId)
      .as("last_connect");

    const filters = and(
      eq(members.organizationId, organizationId),
      buildTokenizedSearchFilter({
        query: name,
        columns: [users.name, users.email],
      }),
      status === "connected" ? isNotNull(lastConnect.userId) : undefined,
      status === "not_connected" ? isNull(lastConnect.userId) : undefined,
    );

    const [rows, [{ total }], [counts]] = await Promise.all([
      db
        .select({
          userId: members.userId,
          name: users.name,
          email: users.email,
          image: users.image,
          lastConnectedAt: lastConnect.lastConnectedAt,
        })
        .from(members)
        .innerJoin(users, eq(members.userId, users.id))
        .leftJoin(lastConnect, eq(lastConnect.userId, members.userId))
        .where(filters)
        .orderBy(
          sql`${lastConnect.lastConnectedAt} desc nulls last`,
          users.name,
          members.userId,
        )
        .limit(pagination.limit)
        .offset(pagination.offset),
      db
        .select({ total: count() })
        .from(members)
        .innerJoin(users, eq(members.userId, users.id))
        .leftJoin(lastConnect, eq(lastConnect.userId, members.userId))
        .where(filters),
      db
        .select({
          memberCount: count(),
          connectedCount: count(lastConnect.userId),
        })
        .from(members)
        .leftJoin(lastConnect, eq(lastConnect.userId, members.userId))
        .where(eq(members.organizationId, organizationId)),
    ]);

    return {
      page: createPaginatedResult(
        rows.map((row) => ({
          ...row,
          image: row.image ?? null,
          lastConnectedAt: row.lastConnectedAt ?? null,
        })),
        Number(total),
        pagination,
      ),
      memberCount: Number(counts?.memberCount ?? 0),
      connectedCount: Number(counts?.connectedCount ?? 0),
    };
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
}

export default ConnectedClientModel;
