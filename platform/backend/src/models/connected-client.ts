import {
  CLAUDE_CLIENT_ID,
  CLAUDE_CODE_CLIENT_ID,
  CLAUDE_DESKTOP_CLIENT_ID,
  CODEX_CLIENT_ID,
  COPILOT_CLI_CLIENT_ID,
  CURSOR_CLIENT_ID,
  type CursorQuery,
  OPENCODE_CLIENT_ID,
} from "@archestra/shared";
import {
  INSTALLER_CLIENT_IDS,
  INSTALLER_CLIENT_LABELS,
} from "@archestra/shared/connection-setup";
import { and, desc, eq, isNotNull, isNull, sql } from "drizzle-orm";
import db, { schema, type Transaction } from "@/database";
import {
  type CursorPaginatedResult,
  createCursorPaginatedResult,
  decodeCursor,
} from "@/database/utils/pagination";
import { connectClientForOAuthClient } from "@/services/connected-client-oauth";
import type {
  AdoptionAgent,
  AgentAdoption,
  AgentAdoptionMember,
  AgentAdoptionStatus,
  AgentAdoptionUsage,
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
          NULL::text AS actor_user_id,
          NULL::text AS oauth_client_id,
          NULL::text AS oauth_client_name,
          NULL::text[] AS redirect_uris
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
          ${setups.revokedByUserId},
          NULL,
          NULL,
          NULL
        FROM ${setups}
        WHERE ${setups.organizationId} = ${organizationId}
          AND ${setups.revokedAt} IS NOT NULL
        GROUP BY ${setups.userId}, ${setups.clientId}, ${setups.revokedAt},
          ${setups.revokedByUserId}
        UNION ALL
        -- Agents set up by hand show up when they first sign in to the
        -- gateway with OAuth, under the name they registered.
        SELECT
          'o:' || k.id,
          'connected',
          date_trunc('milliseconds', k.created_at),
          k.user_id,
          NULL,
          NULL,
          NULL,
          NULL,
          false,
          false,
          NULL,
          c.client_id,
          c.name,
          c.redirect_uris
        FROM ${schema.oauthConsentsTable} k
        JOIN ${schema.oauthClientsTable} c ON c.client_id = k.client_id
        WHERE k.user_id IN (
          SELECT ${schema.membersTable.userId} FROM ${schema.membersTable}
          WHERE ${schema.membersTable.organizationId} = ${organizationId})
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
        ...(row.oauth_client_id
          ? {
              via: "oauthSignIn" as const,
              ...renameIdentity(
                oauthAgentIdentity({
                  user_id: row.user_id,
                  oauth_client_id: row.oauth_client_id,
                  name: row.oauth_client_name,
                  redirect_uris: row.redirect_uris,
                }),
              ),
            }
          : {
              via: "setup" as const,
              clientId: row.client_id,
              agentName: row.client_id
                ? INSTALLER_CLIENT_LABELS[row.client_id]
                : "Unknown agent",
            }),
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
   * Gateway traffic counts calls any outside agent sent over the HTTP gateway,
   * whatever it signed in with; the built-in chat marks its own calls. LLM
   * proxy traffic counts external API calls, attributed to the passthrough
   * key's owner when one was sent, since the user header alone is only a hint.
   * Both leave out Archestra's built-in agents (runs and agent-to-agent calls),
   * which would otherwise pass for a member's own agent.
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

    const [members, setUp, signIns, gateway, llm, skills] = await Promise.all([
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
      // Gateway sign-ins: every agent that signs in with OAuth consents once
      // per client, under the name it registered.
      db.execute<OAuthAgentRow & { signed_in_at: Date | string }>(sql`
        SELECT k.user_id, c.client_id AS oauth_client_id, c.name,
          c.redirect_uris, min(k.created_at) AS signed_in_at
        FROM ${schema.oauthConsentsTable} k
        JOIN ${schema.oauthClientsTable} c ON c.client_id = k.client_id
        WHERE k.user_id IS NOT NULL
        GROUP BY k.user_id, c.client_id, c.name, c.redirect_uris
      `),
      db.execute<
        OAuthAgentRow & { source: string | null; last_seen_at: Date | string }
      >(sql`
        SELECT ${toolCalls.userId} AS user_id,
          ${toolCalls.oauthClientId} AS oauth_client_id, c.name,
          c.redirect_uris, ${toolCalls.source} AS source,
          max(${toolCalls.createdAt}) AS last_seen_at
        FROM ${toolCalls}
        LEFT JOIN ${schema.oauthClientsTable} c
          ON c.client_id = ${toolCalls.oauthClientId}
        WHERE ${toolCalls.createdAt} >= ${sinceTs}
          AND ${agentGatewayTraffic()}
          AND ${toolCalls.userId} IS NOT NULL
          AND ${toolCalls.agentId} IN (${orgAgents})
        GROUP BY 1, 2, 3, 4, 5
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
          AND ${agentLlmTraffic(organizationId)}
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
        agents: [],
        gatewayLastSeenAt: null,
        llmLastSeenAt: null,
        skillLastUsedAt: null,
      });
    }
    /** The member's entry for one agent, created on first sight. */
    const agentOf = (
      member: AgentAdoptionMember,
      identity: { clientId: string | null; name: string },
    ): AdoptionAgent => {
      const key = identity.clientId ?? `name:${identity.name.toLowerCase()}`;
      let agent = member.agents.find(
        (a) => (a.clientId ?? `name:${a.name.toLowerCase()}`) === key,
      );
      if (!agent) {
        agent = {
          ...identity,
          setUpAt: null,
          signedInAt: null,
          gatewayLastSeenAt: null,
          llmLastSeenAt: null,
        };
        member.agents.push(agent);
      }
      return agent;
    };

    for (const row of setUp.rows) {
      const member = byUser.get(row.user_id);
      if (!member) continue;
      agentOf(member, {
        clientId: row.client_id,
        name: INSTALLER_CLIENT_LABELS[row.client_id],
      }).setUpAt = toUtcDate(row.last_set_up_at);
    }
    for (const row of signIns.rows) {
      const member = byUser.get(row.user_id);
      if (!member) continue;
      agentOf(member, oauthAgentIdentity(row)).signedInAt = toUtcDate(
        row.signed_in_at,
      );
    }
    for (const row of gateway.rows) {
      const member = byUser.get(row.user_id);
      if (!member) continue;
      const lastSeen = toUtcDate(row.last_seen_at);
      member.gatewayLastSeenAt = latest(member.gatewayLastSeenAt, lastSeen);
      // Outside agents on a pasted token send nothing to name them by; older rows
      // (no source) predate recording the OAuth client, so name no agent.
      if (!row.oauth_client_id && row.source !== "api") continue;
      const agent = agentOf(
        member,
        row.oauth_client_id ? oauthAgentIdentity(row) : GENERIC_AGENT,
      );
      agent.gatewayLastSeenAt = latest(agent.gatewayLastSeenAt, lastSeen);
    }
    for (const row of llm.rows) {
      const member = byUser.get(row.user_id);
      if (!member) continue;
      const lastSeen = toUtcDate(row.last_seen_at);
      member.llmLastSeenAt = latest(member.llmLastSeenAt, lastSeen);
      const agent = agentOf(member, llmAgentIdentity(row.agent));
      agent.llmLastSeenAt = latest(agent.llmLastSeenAt, lastSeen);
    }
    for (const row of skills.rows) {
      const member = byUser.get(row.user_id);
      if (member) member.skillLastUsedAt = toUtcDate(row.last_used_at);
    }
    for (const member of byUser.values()) {
      member.status = adoptionStatus(member, activeSince);
      member.agents.sort((a, b) => a.name.localeCompare(b.name));
    }

    return { activeDays, lookbackDays, members: [...byUser.values()] };
  }

  /**
   * Daily MCP gateway and LLM proxy calls from members' agents over the
   * lookback window, oldest day first, for one member or the whole
   * organization. Counts the same traffic as `getAdoption`.
   */
  static async getAdoptionUsage(params: {
    organizationId: string;
    lookbackDays: number;
    userId?: string;
    now?: Date;
  }): Promise<AgentAdoptionUsage> {
    const { organizationId, lookbackDays, userId } = params;
    const now = params.now ?? new Date();
    const firstDay = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) -
        (lookbackDays - 1) * DAY_MS,
    );
    const sinceTs = sql`${firstDay.toISOString()}::timestamp`;
    const orgAgents = sql`SELECT ${schema.agentsTable.id} FROM ${schema.agentsTable} WHERE ${schema.agentsTable.organizationId} = ${organizationId}`;
    const orgMembers = userId
      ? sql`SELECT ${schema.membersTable.userId} FROM ${schema.membersTable} WHERE ${schema.membersTable.organizationId} = ${organizationId} AND ${schema.membersTable.userId} = ${userId}`
      : sql`SELECT ${schema.membersTable.userId} FROM ${schema.membersTable} WHERE ${schema.membersTable.organizationId} = ${organizationId}`;
    const interactions = schema.interactionsTable;
    const toolCalls = schema.mcpToolCallsTable;

    const [gateway, llm] = await Promise.all([
      db.execute<{ day: string; calls: number }>(sql`
        SELECT to_char(date_trunc('day', ${toolCalls.createdAt}), 'YYYY-MM-DD') AS day,
          count(*)::int AS calls
        FROM ${toolCalls}
        WHERE ${toolCalls.createdAt} >= ${sinceTs}
          AND ${agentGatewayTraffic()}
          AND ${toolCalls.agentId} IN (${orgAgents})
          AND ${toolCalls.userId} IN (${orgMembers})
        GROUP BY 1
      `),
      db.execute<{ day: string; calls: number }>(sql`
        SELECT to_char(date_trunc('day', ${interactions.createdAt}), 'YYYY-MM-DD') AS day,
          count(*)::int AS calls
        FROM ${interactions}
        LEFT JOIN ${schema.virtualApiKeysTable} k
          ON k.id = ${interactions.passthroughVirtualKeyId}
        WHERE ${interactions.createdAt} >= ${sinceTs}
          AND ${agentLlmTraffic(organizationId)}
          AND (${interactions.profileId} IN (${orgAgents})
            OR ${interactions.profileId} IS NULL)
          AND coalesce(k.author_id, ${interactions.userId}) IN (${orgMembers})
        GROUP BY 1
      `),
    ]);

    const gatewayByDay = new Map(gateway.rows.map((r) => [r.day, r.calls]));
    const llmByDay = new Map(llm.rows.map((r) => [r.day, r.calls]));
    const days = Array.from({ length: lookbackDays }, (_, i) => {
      const date = new Date(firstDay.getTime() + i * DAY_MS)
        .toISOString()
        .slice(0, 10);
      return {
        date,
        gatewayCalls: gatewayByDay.get(date) ?? 0,
        llmCalls: llmByDay.get(date) ?? 0,
      };
    });
    return { lookbackDays, days };
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

/**
 * Gateway calls a member's own agent made: anything sent over the HTTP
 * gateway except the built-in chat's loopback client and agent runs. Rows
 * from before the gateway recorded the sender count only when signed in with
 * OAuth, the one way outside agents could be told apart then.
 */
function agentGatewayTraffic() {
  const toolCalls = schema.mcpToolCallsTable;
  return sql`${toolCalls.runId} IS NULL
    AND (${toolCalls.source} = 'api'
      OR (${toolCalls.source} IS NULL AND ${toolCalls.authMethod} = 'oauth'))`;
}

/**
 * LLM proxy calls a member's own agent made: external API traffic, minus
 * Archestra's built-in agents. Those also reach the proxy as API traffic, but
 * agent runs stamp a run id and agent-to-agent calls name an Archestra agent
 * (`<agentId>` or `<agentId>:<agentId>`) as the external agent.
 */
function agentLlmTraffic(organizationId: string) {
  const interactions = schema.interactionsTable;
  return sql`(${interactions.source} = 'api' OR ${interactions.source} IS NULL)
    AND ${interactions.runId} IS NULL
    AND (${interactions.externalAgentId} IS NULL
      OR split_part(${interactions.externalAgentId}, ':', 1) NOT IN (
        SELECT ${schema.agentsTable.id}::text FROM ${schema.agentsTable}
        WHERE ${schema.agentsTable.organizationId} = ${organizationId}))`;
}

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
  return member.agents.some((a) => a.setUpAt || a.signedInAt)
    ? "setUp"
    : "notConnected";
}

/**
 * Best effort ends here: an agent that sent nothing we can name is the
 * Connect page's "Generic client".
 */
const GENERIC_AGENT = { clientId: "generic", name: "Generic client" };

/** An OAuth client as the adoption queries read it. */
interface OAuthAgentRow extends Record<string, unknown> {
  user_id: string;
  oauth_client_id: string | null;
  name: string | null;
  redirect_uris: string[] | null;
}

/**
 * Which agent an OAuth client is: the Connect client it verifiably belongs to
 * or whose name it carries, else whatever name it registered under.
 */
function oauthAgentIdentity(row: OAuthAgentRow): {
  clientId: string | null;
  name: string;
} {
  const connectClient = connectClientForOAuthClient({
    clientId: row.oauth_client_id ?? "",
    name: row.name,
    redirectUris: row.redirect_uris ?? [],
  });
  if (connectClient) {
    return {
      clientId: connectClient,
      name:
        connectClient === "amp"
          ? "Amp"
          : INSTALLER_CLIENT_LABELS[connectClient],
    };
  }
  const name = row.name?.trim();
  if (!name) return GENERIC_AGENT;
  const byLabel = INSTALLER_CLIENT_IDS.find(
    (id) => INSTALLER_CLIENT_LABELS[id].toLowerCase() === name.toLowerCase(),
  );
  return byLabel
    ? { clientId: byLabel, name: INSTALLER_CLIENT_LABELS[byLabel] }
    : { clientId: null, name };
}

/** LLM proxy `external_agent_id` values the Connect page's agents send. */
const LLM_AGENT_CLIENT: Record<string, ConnectionSetupClientId> = {
  [CLAUDE_CODE_CLIENT_ID]: "claude-code",
  [CLAUDE_DESKTOP_CLIENT_ID]: "claude-desktop",
  [CODEX_CLIENT_ID]: "codex",
  [COPILOT_CLI_CLIENT_ID]: "copilot-cli",
  [CURSOR_CLIENT_ID]: "cursor",
  [OPENCODE_CLIENT_ID]: "opencode",
};

/**
 * Which agent an LLM proxy call came from, best effort, by its
 * `external_agent_id`: an id the proxy recognised or the agent sent itself,
 * a Claude client it couldn't tell apart, or the generic client when nothing
 * named it.
 */
function llmAgentIdentity(agent: string | null): {
  clientId: string | null;
  name: string;
} {
  if (!agent) return GENERIC_AGENT;
  const installer = LLM_AGENT_CLIENT[agent];
  if (installer) {
    return { clientId: installer, name: INSTALLER_CLIENT_LABELS[installer] };
  }
  if (agent === CLAUDE_CLIENT_ID) return { clientId: null, name: "Claude" };
  return { clientId: agent, name: agent };
}

/** A raw row of {@link ConnectedClientModel.listEvents}' query. */
interface ConnectionEventRow extends Record<string, unknown> {
  id: string;
  action: ConnectionEventAction;
  occurred_at: Date | string;
  user_id: string;
  user_name: string;
  user_email: string;
  client_id: ConnectionSetupClientId | null;
  platform: ConnectionSetupPlatform | null;
  device_name: string | null;
  mcp_gateway_id: string | null;
  mcp_gateway_name: string | null;
  model_routing: boolean;
  include_skills: boolean;
  actor_user_id: string | null;
  actor_name: string | null;
  actor_email: string | null;
  oauth_client_id: string | null;
  oauth_client_name: string | null;
  redirect_uris: string[] | null;
}

function renameIdentity(identity: { clientId: string | null; name: string }) {
  return { clientId: identity.clientId, agentName: identity.name };
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
