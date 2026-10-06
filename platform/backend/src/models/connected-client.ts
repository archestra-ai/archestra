import type { CursorQuery } from "@archestra/shared";
import { and, desc, eq, isNotNull, isNull, sql } from "drizzle-orm";
import db, { schema, type Transaction } from "@/database";
import {
  type CursorPaginatedResult,
  createCursorPaginatedResult,
  decodeCursor,
} from "@/database/utils/pagination";
import type {
  AgentAdoption,
  AgentAdoptionMember,
  AgentAdoptionStatus,
  ConnectedClientId,
  ConnectedClientRecord,
  ConnectionEvent,
  ConnectionEventAction,
  ConnectionSetupClientId,
  ConnectionSetupPlatform,
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
   * The organization's connection events, newest first: a "connected" event
   * each time a setup was redeemed, and a "disconnected" event each time a
   * user's client was disconnected (one event per disconnect, however many
   * setups it stamped). Keyset-paginated on (time, event id).
   */
  static async listEvents(params: {
    organizationId: string;
    pagination: CursorQuery;
    userId?: string;
    clientId?: ConnectionSetupClientId;
    action?: ConnectionEventAction;
    startDate?: string;
    endDate?: string;
  }): Promise<CursorPaginatedResult<ConnectionEvent>> {
    const { organizationId, pagination } = params;
    const users = schema.usersTable;
    const conditions = [
      params.userId ? sql`e.user_id = ${params.userId}` : undefined,
      params.clientId ? sql`e.client_id = ${params.clientId}` : undefined,
      params.action ? sql`e.action = ${params.action}` : undefined,
      params.startDate
        ? sql`e.occurred_at >= ${params.startDate}::timestamp`
        : undefined,
      params.endDate
        ? sql`e.occurred_at <= ${params.endDate}::timestamp`
        : undefined,
    ];
    const position = decodeCursor(pagination.cursor);
    if (position && !Number.isNaN(new Date(position.value).getTime())) {
      conditions.push(
        sql`(e.occurred_at, e.id) < (${position.value}::timestamp, ${position.id})`,
      );
    }
    const where = conditions.filter((c) => c !== undefined);

    // Timestamps are millisecond-truncated so a cursor taken from a JS Date
    // compares equal to the row it came from.
    const { rows } = await db.execute<ConnectionEventRow>(sql`
      WITH e AS (
        SELECT
          'c:' || ${setups.id}::text AS id,
          'connected' AS action,
          date_trunc('milliseconds', ${setups.consumedAt}) AS occurred_at,
          ${setups.userId} AS user_id,
          ${setups.clientId} AS client_id,
          ${setups.platform} AS platform,
          ${setups.deviceName} AS device_name,
          ${setups.mcpGatewayId} AS mcp_gateway_id,
          ${setups.llmProxyId} IS NOT NULL AS model_routing,
          ${setups.includeSkills} AS include_skills,
          NULL::text AS actor_user_id
        FROM ${setups}
        WHERE ${setups.organizationId} = ${organizationId}
          AND ${setups.consumedAt} IS NOT NULL
        UNION ALL
        SELECT
          'd:' || min(${setups.id}::text),
          'disconnected',
          date_trunc('milliseconds', ${setups.revokedAt}),
          ${setups.userId},
          ${setups.clientId},
          NULL,
          NULL,
          NULL,
          false,
          false,
          ${setups.revokedByUserId}
        FROM ${setups}
        WHERE ${setups.organizationId} = ${organizationId}
          AND ${setups.revokedAt} IS NOT NULL
        GROUP BY ${setups.userId}, ${setups.clientId}, ${setups.revokedAt},
          ${setups.revokedByUserId}
      )
      SELECT
        e.*,
        u.name AS user_name,
        u.email AS user_email,
        g.name AS mcp_gateway_name,
        actor.name AS actor_name,
        actor.email AS actor_email
      FROM e
      JOIN ${users} u ON u.id = e.user_id
      LEFT JOIN ${schema.agentsTable} g ON g.id = e.mcp_gateway_id
      LEFT JOIN ${users} actor ON actor.id = e.actor_user_id
      ${where.length > 0 ? sql`WHERE ${sql.join(where, sql` AND `)}` : sql``}
      ORDER BY e.occurred_at DESC, e.id DESC
      LIMIT ${pagination.limit + 1}
    `);

    const events = rows.map(
      (row): ConnectionEvent => ({
        id: row.id,
        action: row.action,
        occurredAt: toUtcDate(row.occurred_at),
        userId: row.user_id,
        userName: row.user_name,
        userEmail: row.user_email,
        clientId: row.client_id,
        platform: row.platform,
        deviceName: row.device_name,
        mcpGateway:
          row.mcp_gateway_id && row.mcp_gateway_name
            ? { id: row.mcp_gateway_id, name: row.mcp_gateway_name }
            : null,
        modelRouting: row.model_routing,
        includeSkills: row.include_skills,
        // Only an admin acting on someone else's client is worth naming.
        disconnectedBy:
          row.actor_user_id && row.actor_user_id !== row.user_id
            ? {
                id: row.actor_user_id,
                name: row.actor_name ?? row.actor_email ?? "Deleted user",
              }
            : null,
      }),
    );
    return createCursorPaginatedResult(events, pagination, (event) => ({
      value: event.occurredAt.toISOString(),
      id: event.id,
    }));
  }

  /**
   * Every organization member with what their agents have done: redeemed
   * setups (any time) and gateway, LLM proxy and skill traffic over the last
   * `lookbackDays`. Traffic, not tickets, decides whether a member counts as
   * connected, because a ticket is redeemed before its install runs.
   *
   * Gateway traffic counts only OAuth sign-ins: that is how every agent set up
   * from the Connect page reaches the gateway, and it leaves out the built-in
   * chat and apps, which write to the same log with other credentials. LLM
   * proxy traffic counts external API calls, attributed to the passthrough
   * key's owner when one was sent, since the user header alone is only a hint.
   */
  static async getAdoption(params: {
    organizationId: string;
    activeDays: number;
    lookbackDays: number;
    now?: Date;
  }): Promise<AgentAdoption> {
    const { organizationId, activeDays, lookbackDays } = params;
    const now = params.now ?? new Date();
    const since = new Date(now.getTime() - lookbackDays * DAY_MS);
    const activeSince = new Date(now.getTime() - activeDays * DAY_MS);
    // Raw timestamps hold UTC wall time; an ISO string cast drops its zone.
    const sinceTs = sql`${since.toISOString()}::timestamp`;
    const orgAgents = sql`SELECT ${schema.agentsTable.id} FROM ${schema.agentsTable} WHERE ${schema.agentsTable.organizationId} = ${organizationId}`;
    const interactions = schema.interactionsTable;
    const toolCalls = schema.mcpToolCallsTable;
    const skillEvents = [
      schema.skillUsageEventsTable,
      schema.pluginSkillUsageEventsTable,
      schema.externalMcpSkillUsageEventsTable,
    ];

    const [members, setUp, gateway, llm, skills] = await Promise.all([
      db.execute<{ user_id: string; name: string; email: string }>(sql`
        SELECT u.id AS user_id, u.name, u.email
        FROM ${schema.membersTable} m
        JOIN ${schema.usersTable} u ON u.id = m.user_id
        WHERE m.organization_id = ${organizationId}
      `),
      db.execute<{
        user_id: string;
        client_id: ConnectionSetupClientId;
        last_set_up_at: Date | string;
      }>(sql`
        SELECT ${setups.userId} AS user_id, ${setups.clientId} AS client_id,
          max(${setups.consumedAt}) AS last_set_up_at
        FROM ${setups}
        WHERE ${setups.organizationId} = ${organizationId}
          AND ${setups.consumedAt} IS NOT NULL
          AND ${setups.revokedAt} IS NULL
        GROUP BY ${setups.userId}, ${setups.clientId}
      `),
      db.execute<{ user_id: string; last_seen_at: Date | string }>(sql`
        SELECT ${toolCalls.userId} AS user_id,
          max(${toolCalls.createdAt}) AS last_seen_at
        FROM ${toolCalls}
        WHERE ${toolCalls.createdAt} >= ${sinceTs}
          AND ${toolCalls.authMethod} = 'oauth'
          AND ${toolCalls.userId} IS NOT NULL
          AND ${toolCalls.agentId} IN (${orgAgents})
        GROUP BY ${toolCalls.userId}
      `),
      db.execute<{
        user_id: string;
        agent: string | null;
        last_seen_at: Date | string;
      }>(sql`
        SELECT coalesce(k.author_id, ${interactions.userId}) AS user_id,
          ${interactions.externalAgentId} AS agent,
          max(${interactions.createdAt}) AS last_seen_at
        FROM ${interactions}
        LEFT JOIN ${schema.virtualApiKeysTable} k
          ON k.id = ${interactions.passthroughVirtualKeyId}
        WHERE ${interactions.createdAt} >= ${sinceTs}
          AND (${interactions.source} = 'api' OR ${interactions.source} IS NULL)
          AND (${interactions.profileId} IN (${orgAgents})
            OR ${interactions.profileId} IS NULL)
          AND coalesce(k.author_id, ${interactions.userId}) IS NOT NULL
        GROUP BY 1, 2
      `),
      db.execute<{ user_id: string; last_used_at: Date | string }>(sql`
        SELECT user_id, max(created_at) AS last_used_at FROM (
          ${sql.join(
            skillEvents.map(
              (table) =>
                sql`SELECT ${table.userId} AS user_id, ${table.createdAt} AS created_at FROM ${table} WHERE ${table.createdAt} >= ${sinceTs} AND ${table.userId} IS NOT NULL`,
            ),
            sql` UNION ALL `,
          )}
        ) s
        GROUP BY user_id
      `),
    ]);

    const byUser = new Map<string, AgentAdoptionMember>();
    for (const row of members.rows) {
      byUser.set(row.user_id, {
        userId: row.user_id,
        name: row.name,
        email: row.email,
        status: "notConnected",
        setUpAgents: [],
        lastSetUpAt: null,
        gatewayLastSeenAt: null,
        llmLastSeenAt: null,
        llmAgents: [],
        skillLastUsedAt: null,
      });
    }
    for (const row of setUp.rows) {
      const member = byUser.get(row.user_id);
      if (!member) continue;
      member.setUpAgents.push(row.client_id);
      member.lastSetUpAt = latest(
        member.lastSetUpAt,
        toUtcDate(row.last_set_up_at),
      );
    }
    for (const row of gateway.rows) {
      const member = byUser.get(row.user_id);
      if (member) member.gatewayLastSeenAt = toUtcDate(row.last_seen_at);
    }
    for (const row of llm.rows) {
      const member = byUser.get(row.user_id);
      if (!member) continue;
      member.llmLastSeenAt = latest(
        member.llmLastSeenAt,
        toUtcDate(row.last_seen_at),
      );
      member.llmAgents.push(row.agent || "unknown");
    }
    for (const row of skills.rows) {
      const member = byUser.get(row.user_id);
      if (member) member.skillLastUsedAt = toUtcDate(row.last_used_at);
    }
    for (const member of byUser.values()) {
      member.status = adoptionStatus(member, activeSince);
      member.setUpAgents.sort();
      member.llmAgents.sort();
    }

    return { activeDays, lookbackDays, members: [...byUser.values()] };
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

const DAY_MS = 24 * 60 * 60 * 1000;

function latest(current: Date | null, next: Date): Date {
  return current && current > next ? current : next;
}

function adoptionStatus(
  member: AgentAdoptionMember,
  activeSince: Date,
): AgentAdoptionStatus {
  const lastSeen = [
    member.gatewayLastSeenAt,
    member.llmLastSeenAt,
  ].reduce<Date | null>(
    (acc, value) => (value ? latest(acc, value) : acc),
    null,
  );
  if (lastSeen) return lastSeen >= activeSince ? "active" : "inactive";
  return member.setUpAgents.length > 0 ? "setUp" : "notConnected";
}

/** A raw row of {@link ConnectedClientModel.listEvents}' query. */
interface ConnectionEventRow extends Record<string, unknown> {
  id: string;
  action: ConnectionEventAction;
  occurred_at: Date | string;
  user_id: string;
  user_name: string;
  user_email: string;
  client_id: ConnectionSetupClientId;
  platform: ConnectionSetupPlatform | null;
  device_name: string | null;
  mcp_gateway_id: string | null;
  mcp_gateway_name: string | null;
  model_routing: boolean;
  include_skills: boolean;
  actor_user_id: string | null;
  actor_name: string | null;
  actor_email: string | null;
}

/**
 * A raw `timestamp without time zone` holds UTC wall time; read it as UTC
 * whether the driver hands back a string or a local-time Date.
 */
function toUtcDate(value: Date | string): Date {
  if (value instanceof Date) {
    return new Date(value.getTime() - value.getTimezoneOffset() * 60_000);
  }
  return new Date(`${value.replace(" ", "T")}Z`);
}

export default ConnectedClientModel;
