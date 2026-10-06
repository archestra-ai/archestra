import type { PaginationQuery } from "@archestra/shared";
import { and, count, desc, eq, isNotNull, isNull } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import db, { schema, type Transaction } from "@/database";
import {
  createPaginatedResult,
  type PaginatedResult,
} from "@/database/utils/pagination";
import { buildTokenizedSearchFilter } from "@/database/utils/text-search";
import type {
  ConnectedClientId,
  ConnectedClientRecord,
  ConnectionLogEntry,
  ConnectionSetupClientId,
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
    const byClient = new Map<ConnectedClientId, ConnectedClientRecord>();
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

    return [...byClient.values()];
  }

  /**
   * The organization's redeemed setups, newest first: one log entry per time
   * someone connected an agent through the Connect page. Search matches the
   * user's name or email.
   */
  static async listLog(params: {
    organizationId: string;
    pagination: PaginationQuery;
    search?: string;
    clientId?: ConnectionSetupClientId;
  }): Promise<PaginatedResult<ConnectionLogEntry>> {
    const users = schema.usersTable;
    const gateways = alias(schema.agentsTable, "mcp_gateways");
    const where = and(
      eq(setups.organizationId, params.organizationId),
      isNotNull(setups.consumedAt),
      params.clientId ? eq(setups.clientId, params.clientId) : undefined,
      buildTokenizedSearchFilter({
        query: params.search,
        columns: [users.name, users.email],
      }),
    );

    const [rows, [{ total }]] = await Promise.all([
      db
        .select({
          id: setups.id,
          consumedAt: setups.consumedAt,
          userId: setups.userId,
          userName: users.name,
          userEmail: users.email,
          clientId: setups.clientId,
          platform: setups.platform,
          deviceName: setups.deviceName,
          mcpGatewayId: gateways.id,
          mcpGatewayName: gateways.name,
          llmProxyId: setups.llmProxyId,
          includeSkills: setups.includeSkills,
          revokedAt: setups.revokedAt,
        })
        .from(setups)
        .innerJoin(users, eq(setups.userId, users.id))
        .leftJoin(gateways, eq(setups.mcpGatewayId, gateways.id))
        .where(where)
        .orderBy(desc(setups.consumedAt), desc(setups.id))
        .limit(params.pagination.limit)
        .offset(params.pagination.offset),
      db
        .select({ total: count() })
        .from(setups)
        .innerJoin(users, eq(setups.userId, users.id))
        .where(where),
    ]);

    return createPaginatedResult(
      rows.map((row) => ({
        id: row.id,
        connectedAt: row.consumedAt as Date,
        userId: row.userId,
        userName: row.userName,
        userEmail: row.userEmail,
        clientId: row.clientId,
        platform: row.platform,
        deviceName: row.deviceName,
        mcpGateway:
          row.mcpGatewayId && row.mcpGatewayName
            ? { id: row.mcpGatewayId, name: row.mcpGatewayName }
            : null,
        modelRouting: row.llmProxyId !== null,
        includeSkills: row.includeSkills,
        disconnectedAt: row.revokedAt,
      })),
      Number(total),
      params.pagination,
    );
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
