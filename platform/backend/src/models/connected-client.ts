import { and, desc, eq, isNotNull, isNull } from "drizzle-orm";
import db, { schema, type Transaction } from "@/database";
import {
  isOAuthClientForConnectClient,
  OAUTH_RECOGNISED_CLIENT_IDS,
} from "@/services/connected-client-oauth";
import type {
  ConnectedClientId,
  ConnectedClientRecord,
  ConnectionSetupClientId,
} from "@/types";
import OAuthClientModel from "./oauth-client";

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

    // Agents the gateway can tell apart by their OAuth client count as
    // connected while the user holds a token for one, set up by hand or not.
    // These are the same rows a disconnect revokes. Merged with a setup entry,
    // the earliest connect is kept as the first and the latest as the last.
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
}

export default ConnectedClientModel;
