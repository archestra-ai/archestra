import { CLAUDE_CLIENT_ID, type CursorQuery } from "@archestra/shared";
import {
  connectAgentLabel,
  INSTALLER_CLIENT_LABELS,
  OAUTH_AGENTS,
} from "@archestra/shared/connection-setup";
import { clientForExternalAgentIds } from "@archestra/shared/interactions/client";
import { and, desc, eq, isNotNull, isNull, type SQL, sql } from "drizzle-orm";
import db, { schema, type Transaction } from "@/database";
import {
  type CursorPaginatedResult,
  createCursorPaginatedResult,
  decodeCursor,
} from "@/database/utils/pagination";
import {
  connectClientForOAuthClient,
  connectClientForOAuthClientSql,
} from "@/services/connected-client-oauth";
import type {
  AdoptionAgent,
  AdoptionUse,
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
          name: connectAgentLabel(row.clientId) ?? row.clientId,
          connectedAt: consumedAt,
          lastConnectedAt: consumedAt,
          deviceNames: [],
          lastSeenAt: null,
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
   * setups it stamped). Agents known only from their gateway sign-in keep
   * no setup, and disconnecting one deletes the sign-in, so their disconnect
   * and the connect it ended come from the audit log's disconnect entry and
   * last as long as it is retained. Keyset-paginated on (time, event id).
   */
  static async listEvents(params: {
    organizationId: string;
    pagination: CursorQuery;
    userId?: string;
    action?: ConnectionEventAction;
    startDate?: string;
    endDate?: string;
  }): Promise<CursorPaginatedResult<ConnectionEvent>> {
    const { organizationId, pagination } = params;
    const users = schema.usersTable;
    const audit = schema.auditLogsTable;
    // Audit times are timestamptz; the rest hold UTC wall time.
    const auditAt = sql`(${audit.occurredAt} AT TIME ZONE 'UTC')`;
    const conditions = [
      params.userId ? sql`e.user_id = ${params.userId}` : undefined,
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
          ${setups.mcpGatewayId} AS setup_gateway_id,
          ${setups.llmProxyId} AS llm_proxy_id,
          ${setups.includeSkills} AS include_skills,
          ${setups.id} AS setup_id,
          NULL::text AS actor_user_id,
          NULL::text AS oauth_client_id,
          NULL::text AS oauth_client_name,
          NULL::text[] AS redirect_uris,
          NULL::text AS signed_in_client_id,
          NULL::timestamp AS connected_until
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
          NULL,
          false,
          NULL,
          ${setups.revokedByUserId},
          NULL,
          NULL,
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
          -- A sign-in names no gateway: looked up below, for the page only.
          NULL,
          NULL,
          false,
          NULL,
          NULL,
          c.client_id,
          c.name,
          c.redirect_uris,
          NULL,
          NULL
        FROM ${schema.oauthConsentsTable} k
        JOIN ${schema.oauthClientsTable} c ON c.client_id = k.client_id
        WHERE k.user_id IN (
          SELECT ${schema.membersTable.userId} FROM ${schema.membersTable}
          WHERE ${schema.membersTable.organizationId} = ${organizationId})
        UNION ALL
        -- Disconnecting a sign-in-only agent deletes its sign-in above and
        -- revokes no setup; the audit entry and its snapshot of the client
        -- keep both the disconnect and the connect it ended.
        SELECT
          'a:' || x.action || ':' || ${audit.id}::text,
          x.action,
          date_trunc('milliseconds', x.occurred_at),
          ${audit.resourceId},
          NULL,
          NULL,
          NULL,
          NULL,
          NULL,
          false,
          NULL,
          CASE WHEN x.action = 'disconnected' THEN ${audit.actorId} END,
          NULL,
          ${audit.before}->>'name',
          NULL,
          ${audit.before}->>'clientId',
          CASE WHEN x.action = 'connected' THEN ${auditAt} END
        FROM ${audit}
        CROSS JOIN LATERAL (VALUES
          ('disconnected', ${auditAt}),
          ('connected',
            (${audit.before}->>'connectedAt')::timestamptz AT TIME ZONE 'UTC')
        ) AS x(action, occurred_at)
        WHERE ${audit.organizationId} = ${organizationId}
          AND ${audit.action} = 'connectedClient.disconnected'
          AND ${audit.outcome} = 'success'
          AND x.occurred_at IS NOT NULL
          -- Only sign-in-only agents: a snapshot with setup details is a
          -- setup disconnect, logged from the setups it revoked.
          AND ${audit.before}->>'platform' IS NULL
          AND ${audit.before}->>'mcpGatewayId' IS NULL
          AND ${audit.before}->>'llmProxyId' IS NULL
      ),
      page AS (
        SELECT e.*, u.name AS user_name, u.email AS user_email
        FROM e
        JOIN ${users} u ON u.id = e.user_id
        ${where.length > 0 ? sql`WHERE ${sql.join(where, sql` AND `)}` : sql``}
        ORDER BY e.occurred_at DESC, e.id DESC
        LIMIT ${pagination.limit + 1}
      )
      -- Lookups run for the page's events only, not the whole log.
      SELECT
        page.*,
        g.id AS mcp_gateway_id,
        g.name AS mcp_gateway_name,
        p.name AS llm_proxy_name,
        (SELECT count(*)::int FROM ${schema.connectionSetupSkillsTable} cs
          WHERE cs.connection_setup_id = page.setup_id) AS skill_count,
        actor.name AS actor_name,
        actor.email AS actor_email
      FROM page
      LEFT JOIN LATERAL (
        SELECT COALESCE(
          page.setup_gateway_id,
          -- The first gateway a signed-in agent called.
          CASE WHEN page.oauth_client_id IS NOT NULL THEN (
            SELECT t.agent_id FROM ${schema.mcpToolCallsTable} t
            WHERE t.user_id = page.user_id
              AND t.oauth_client_id = page.oauth_client_id
            ORDER BY t.created_at LIMIT 1) END,
          -- For one known only from its audit entry: the first it called
          -- while connected.
          CASE WHEN page.connected_until IS NOT NULL THEN (
            SELECT t.agent_id FROM ${schema.mcpToolCallsTable} t
            JOIN ${schema.oauthClientsTable} c ON c.client_id = t.oauth_client_id
            WHERE t.user_id = page.user_id
              AND t.created_at BETWEEN page.occurred_at AND page.connected_until
              -- The same agent: its known Connect id, or for one nobody
              -- listed, the very OAuth client it signed in with.
              AND (${connectClientForOAuthClientSql({
                clientId: sql`c.client_id`,
                name: sql`c.name`,
                redirectUris: sql`c.redirect_uris`,
              })} = page.signed_in_client_id
                OR 'oauth:' || c.client_id = page.signed_in_client_id)
            ORDER BY t.created_at LIMIT 1) END
        ) AS id
      ) gw ON true
      LEFT JOIN ${schema.agentsTable} g ON g.id = gw.id
      LEFT JOIN ${schema.agentsTable} p ON p.id = page.llm_proxy_id
      LEFT JOIN ${users} actor ON actor.id = page.actor_user_id
      ORDER BY page.occurred_at DESC, page.id DESC
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
          : row.signed_in_client_id
            ? {
                via: "oauthSignIn" as const,
                ...signedInAgent(
                  row.signed_in_client_id,
                  row.oauth_client_name,
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
        llmProxy: row.llm_proxy_id
          ? {
              id: row.llm_proxy_id,
              name: row.llm_proxy_name ?? "Deleted proxy",
            }
          : null,
        includeSkills: row.include_skills,
        skillCount: row.skill_count ?? 0,
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
   * Every organization member with their agents and what those did. Traffic,
   * not tickets, decides where a member stands, because a ticket is redeemed
   * before its install runs: see {@link AgentAdoptionStatusSchema}. States
   * read the last 30 days before now and the last calls read a 180-day
   * lookback, whatever the window; only `gatewayUses`/`llmUses` follow it.
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
    window: AdoptionWindow;
    /** Only this member, e.g. for the Connect page's own agents. */
    userId?: string;
    now?: Date;
  }): Promise<AgentAdoption> {
    const { organizationId, userId } = params;
    const onlyUser = (column: SQL) =>
      userId ? sql` AND ${column} = ${userId}` : sql``;
    const { since, until } = params.window;
    const now = params.now ?? new Date();
    const activeSince = new Date(now.getTime() - ACTIVE_DAYS * DAY_MS);
    // The lookback for last calls, or further when the window reaches back.
    const readFrom = new Date(
      Math.min(
        since.getTime(),
        now.getTime() - LAST_CALL_LOOKBACK_DAYS * DAY_MS,
      ),
    );
    const inWindow = (column: SQL) =>
      sql`${column} BETWEEN ${timestampSql(since)} AND ${timestampSql(until)}`;
    const orgAgents = orgAgentIds(organizationId);
    const interactions = schema.interactionsTable;
    const toolCalls = schema.mcpToolCallsTable;
    type TrafficRow = {
      via_id: string | null;
      via_name: string | null;
      /** Calls in the window, and the newest of them. */
      calls: number;
      window_last_at: Date | string | null;
      last_call_at: Date | string;
      /** Gateway only: newest tool call, the last call that did something. */
      last_tool_call_at?: Date | string | null;
      /** Newest call that did something, in the last 30 days. */
      last_use_at: Date | string | null;
    };
    const [members, gateway, llm, setupRows, signIns] = await Promise.all([
      db.execute<{ user_id: string; name: string; email: string }>(sql`
        SELECT u.id AS user_id, u.name, u.email
        FROM ${schema.membersTable} m
        JOIN ${schema.usersTable} u ON u.id = m.user_id
        WHERE m.organization_id = ${organizationId}${onlyUser(sql`m.user_id`)}
      `),
      db.execute<OAuthAgentRow & TrafficRow>(sql`
        SELECT ${toolCalls.userId} AS user_id,
          ${toolCalls.oauthClientId} AS oauth_client_id, c.name,
          c.redirect_uris, ${toolCalls.agentId} AS via_id, g.name AS via_name,
          count(*) FILTER (WHERE ${inWindow(sql`${toolCalls.createdAt}`)})::int AS calls,
          max(${toolCalls.createdAt}) FILTER (WHERE ${inWindow(sql`${toolCalls.createdAt}`)}) AS window_last_at,
          max(${toolCalls.createdAt}) AS last_call_at,
          -- Starting an agent logs initialize and tools/list; only a tool
          -- call is doing something.
          max(${toolCalls.createdAt}) FILTER (WHERE ${toolCalls.method} = 'tools/call') AS last_tool_call_at,
          max(${toolCalls.createdAt}) FILTER (WHERE ${toolCalls.method} = 'tools/call'
            AND ${toolCalls.createdAt} >= ${timestampSql(activeSince)}) AS last_use_at
        FROM ${toolCalls}
        LEFT JOIN ${schema.oauthClientsTable} c
          ON c.client_id = ${toolCalls.oauthClientId}
        LEFT JOIN ${schema.agentsTable} g ON g.id = ${toolCalls.agentId}
        WHERE ${toolCalls.createdAt} >= ${timestampSql(readFrom)}
          AND ${agentGatewayTraffic()}
          AND ${toolCalls.userId} IS NOT NULL${onlyUser(sql`${toolCalls.userId}`)}
          AND ${toolCalls.agentId} IN (${orgAgents})
        GROUP BY 1, 2, 3, 4, 5, 6
      `),
      db.execute<{ user_id: string; agent: string | null } & TrafficRow>(sql`
        SELECT coalesce(k.author_id, ${interactions.userId}) AS user_id,
          ${interactions.externalAgentId} AS agent,
          ${interactions.profileId} AS via_id, p.name AS via_name,
          count(*) FILTER (WHERE ${inWindow(sql`${interactions.createdAt}`)})::int AS calls,
          max(${interactions.createdAt}) FILTER (WHERE ${inWindow(sql`${interactions.createdAt}`)}) AS window_last_at,
          max(${interactions.createdAt}) AS last_call_at,
          max(${interactions.createdAt}) FILTER (WHERE ${interactions.createdAt} >= ${timestampSql(activeSince)}) AS last_use_at
        FROM ${interactions}
        LEFT JOIN ${schema.virtualApiKeysTable} k
          ON k.id = ${interactions.passthroughVirtualKeyId}
        LEFT JOIN ${schema.agentsTable} p ON p.id = ${interactions.profileId}
        WHERE ${interactions.createdAt} >= ${timestampSql(readFrom)}
          AND ${agentLlmTraffic(organizationId)}
          AND (${interactions.profileId} IN (${orgAgents})
            OR ${interactions.profileId} IS NULL)
          AND coalesce(k.author_id, ${interactions.userId}) IS NOT NULL${onlyUser(sql`coalesce(k.author_id, ${interactions.userId})`)}
        GROUP BY 1, 2, 3, 4
      `),
      // Redeemed setups not yet disconnected, dated by the first.
      db.execute<{
        user_id: string;
        client_id: ConnectionSetupClientId;
        setup_at: Date | string;
      }>(sql`
        SELECT s.user_id, s.client_id, min(s.consumed_at) AS setup_at
        FROM ${setups} s
        WHERE s.organization_id = ${organizationId}
          AND s.consumed_at IS NOT NULL AND s.revoked_at IS NULL${onlyUser(sql`s.user_id`)}
        GROUP BY 1, 2
      `),
      // Gateway sign-ins: agents set up by hand.
      db.execute<OAuthAgentRow & { signed_in_at: Date | string }>(sql`
        SELECT k.user_id, c.client_id AS oauth_client_id, c.name,
          c.redirect_uris, k.created_at AS signed_in_at
        FROM ${schema.oauthConsentsTable} k
        JOIN ${schema.oauthClientsTable} c ON c.client_id = k.client_id
        WHERE k.user_id IN (
          SELECT ${schema.membersTable.userId} FROM ${schema.membersTable}
          WHERE ${schema.membersTable.organizationId} = ${organizationId})${onlyUser(sql`k.user_id`)}
      `),
    ]);

    const byUser = new Map<string, AgentAdoptionMember>();
    for (const row of members.rows) {
      byUser.set(row.user_id, {
        userId: row.user_id,
        name: row.name,
        email: row.email,
        status: "notConnected",
        gatewayLastSeenAt: null,
        llmLastSeenAt: null,
        agents: [],
        gatewayUses: [],
        llmUses: [],
      });
    }
    // The newest call that did something, per agent.
    const lastUse = new Map<object, Date>();
    const noteUse = (key: object, at: Date | string | null) => {
      if (!at) return;
      lastUse.set(key, latest(lastUse.get(key) ?? null, toUtcDate(at)));
    };
    // Agents that ever reached the gateway or proxy, starting up included.
    const reached = new Set<object>();
    for (const row of setupRows.rows) {
      const member = byUser.get(row.user_id);
      if (!member) continue;
      const agent = agentOf(member, {
        clientId: row.client_id,
        name: INSTALLER_CLIENT_LABELS[row.client_id] ?? row.client_id,
      });
      agent.setupAt = earliest(agent.setupAt, toUtcDate(row.setup_at));
      agent.viaToken = false;
    }
    for (const row of signIns.rows) {
      const member = byUser.get(row.user_id);
      if (!member) continue;
      const agent = agentOf(member, oauthAgentIdentity(row));
      if (!agent.setupAt) agent.signedIn = true;
      agent.setupAt = earliest(agent.setupAt, toUtcDate(row.signed_in_at));
      agent.viaToken = false;
    }
    for (const row of gateway.rows) {
      const member = byUser.get(row.user_id);
      if (!member) continue;
      // Outside agents on a pasted token send nothing to name them by, and
      // older rows (no source) predate recording the OAuth client.
      const identity = row.oauth_client_id
        ? oauthAgentIdentity(row)
        : GENERIC_AGENT;
      const agent = row.oauth_client_id
        ? agentOf(member, identity)
        : agentOf(member, UNKNOWN_AGENT, true);
      reached.add(agent);
      // The call columns show the last tool call; starting up isn't one.
      if (row.last_tool_call_at) {
        const lastCall = toUtcDate(row.last_tool_call_at);
        member.gatewayLastSeenAt = latest(member.gatewayLastSeenAt, lastCall);
        agent.lastGatewayCallAt = latest(agent.lastGatewayCallAt, lastCall);
      }
      noteUse(agent, row.last_use_at);
      if (row.calls > 0 && row.window_last_at) {
        addUse(member.gatewayUses, {
          via: { id: row.via_id, name: row.via_name ?? "Deleted gateway" },
          agent: identity,
          calls: row.calls,
          lastSeenAt: toUtcDate(row.window_last_at),
        });
      }
    }
    for (const row of llm.rows) {
      const member = byUser.get(row.user_id);
      if (!member) continue;
      const identity = llmAgentIdentity(row.agent);
      const lastCall = toUtcDate(row.last_call_at);
      member.llmLastSeenAt = latest(member.llmLastSeenAt, lastCall);
      const agent = agentOf(member, identity, true);
      reached.add(agent);
      agent.lastLlmCallAt = latest(agent.lastLlmCallAt, lastCall);
      noteUse(agent, row.last_use_at);
      if (row.calls > 0 && row.window_last_at) {
        addUse(member.llmUses, {
          via: {
            id: row.via_id,
            name:
              row.via_name ?? (row.via_id ? "Deleted LLM proxy" : "LLM proxy"),
          },
          agent: identity,
          calls: row.calls,
          lastSeenAt: toUtcDate(row.window_last_at),
        });
      }
    }
    const statusOf = (agent: AdoptionAgent): AgentAdoptionStatus =>
      lastUse.has(agent)
        ? "active"
        : reached.has(agent)
          ? "inactive"
          : "notConnected";
    for (const member of byUser.values()) {
      // A disconnected agent leaves the list: its setups are revoked and its
      // sign-in deleted, though its old calls still count for the member.
      member.agents = member.agents.filter((a) => a.setupAt || a.viaToken);
      for (const agent of member.agents) {
        agent.status = statusOf(agent);
      }
      // A user stands where their most active connected agent does: with
      // none connected, they're not connected, whatever they did before.
      member.status = member.agents.some((a) => a.status === "active")
        ? "active"
        : member.agents.some((a) => a.status === "inactive")
          ? "inactive"
          : "notConnected";
      for (const uses of [member.gatewayUses, member.llmUses]) {
        uses.sort((a, b) => b.lastSeenAt.getTime() - a.lastSeenAt.getTime());
      }
    }

    return { since, until, members: [...byUser.values()] };
  }

  /**
   * Daily MCP gateway and LLM proxy calls from members' agents over the
   * lookback window, oldest day first, for one member or the whole
   * organization. Counts the same traffic as `getAdoption`.
   */
  static async getAdoptionUsage(params: {
    organizationId: string;
    window: AdoptionWindow;
    userId?: string;
  }): Promise<AgentAdoptionUsage> {
    const { organizationId, userId } = params;
    const { since, until } = params.window;
    const inWindow = (column: SQL) =>
      sql`${column} BETWEEN ${timestampSql(since)} AND ${timestampSql(until)}`;
    const orgAgents = orgAgentIds(organizationId);
    const orgMembers = sql`SELECT ${schema.membersTable.userId} FROM ${schema.membersTable} WHERE ${schema.membersTable.organizationId} = ${organizationId}${userId ? sql` AND ${schema.membersTable.userId} = ${userId}` : sql``}`;
    const interactions = schema.interactionsTable;
    const toolCalls = schema.mcpToolCallsTable;

    const [gateway, llm] = await Promise.all([
      db.execute<{ day: string; calls: number }>(sql`
        SELECT to_char(date_trunc('day', ${toolCalls.createdAt}), 'YYYY-MM-DD') AS day,
          count(*)::int AS calls
        FROM ${toolCalls}
        WHERE ${inWindow(sql`${toolCalls.createdAt}`)}
          AND ${agentGatewayTraffic()}
          -- Tool calls only: starting an agent isn't using it.
          AND ${toolCalls.method} = 'tools/call'
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
        WHERE ${inWindow(sql`${interactions.createdAt}`)}
          AND ${agentLlmTraffic(organizationId)}
          AND (${interactions.profileId} IN (${orgAgents})
            OR ${interactions.profileId} IS NULL)
          AND coalesce(k.author_id, ${interactions.userId}) IN (${orgMembers})
        GROUP BY 1
      `),
    ]);

    const gatewayByDay = new Map(gateway.rows.map((r) => [r.day, r.calls]));
    const llmByDay = new Map(llm.rows.map((r) => [r.day, r.calls]));
    // Every UTC day the window touches, quiet ones included.
    const days = [];
    for (
      let day = utcDay(since);
      day.getTime() <= until.getTime();
      day = new Date(day.getTime() + DAY_MS)
    ) {
      const date = day.toISOString().slice(0, 10);
      days.push({
        date,
        gatewayCalls: gatewayByDay.get(date) ?? 0,
        llmCalls: llmByDay.get(date) ?? 0,
      });
    }
    return { since, until, days };
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

/** The span adoption reads traffic over, start and end included. */
interface AdoptionWindow {
  since: Date;
  until: Date;
}

/** The last `days` days up to `now`. */
export function lastDays(days: number, now = new Date()): AdoptionWindow {
  return { since: new Date(now.getTime() - days * DAY_MS), until: now };
}

/** Raw timestamps hold UTC wall time; an ISO string cast drops its zone. */
function timestampSql(date: Date): SQL {
  return sql`${date.toISOString()}::timestamp`;
}

function utcDay(date: Date): Date {
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );
}

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

/**
 * Count calls into the member's use of one gateway or proxy by one agent,
 * merging rows that name the same pair (an agent can sign in more than once).
 */
function addUse(uses: AdoptionUse[], use: AdoptionUse) {
  const key = (u: AdoptionUse) =>
    `${u.via.id}|${u.agent.clientId ?? `name:${u.agent.name.toLowerCase()}`}`;
  const known = uses.find((u) => key(u) === key(use));
  if (!known) {
    uses.push(use);
    return;
  }
  known.calls += use.calls;
  known.lastSeenAt = latest(known.lastSeenAt, use.lastSeenAt);
}

function latest(current: Date | null, next: Date): Date {
  return current && current > next ? current : next;
}

function earliest(current: Date | null, next: Date): Date {
  return current && current < next ? current : next;
}

/** States read this far back, whatever the window. */
const ACTIVE_DAYS = 30;
/** Last calls read this far back, to keep the interactions scan bounded. */
const LAST_CALL_LOOKBACK_DAYS = 180;

/** Gateway calls on a pasted token: the agent didn't say what it is. */
const UNKNOWN_AGENT = { clientId: null, name: "Unknown agent" };

/**
 * The member's entry for an agent, keyed as {@link addUse} keys them so a
 * setup, its sign-in and its traffic land on one entry. One first seen in
 * traffic is marked as calling on a pasted token until a setup or sign-in
 * claims it.
 */
function agentOf(
  member: AgentAdoptionMember,
  identity: { clientId: string | null; name: string },
  fromTraffic = false,
): AdoptionAgent {
  const key = (a: { clientId: string | null; name: string }) =>
    a.clientId ?? `name:${a.name.toLowerCase()}`;
  const known = member.agents.find((a) => key(a) === key(identity));
  if (known) return known;
  const agent: AdoptionAgent = {
    clientId: identity.clientId,
    name: identity.name,
    status: "notConnected",
    setupAt: null,
    signedIn: false,
    viaToken: fromTraffic,
    lastGatewayCallAt: null,
    lastLlmCallAt: null,
  };
  member.agents.push(agent);
  return agent;
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
 * Which agent an OAuth client is: the Connect client it verifiably belongs to,
 * else whatever name it registered under (the UI matches that to an icon).
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
    return { clientId: connectClient, name: OAUTH_AGENTS[connectClient].label };
  }
  const name = row.name?.trim();
  return name ? { clientId: null, name } : GENERIC_AGENT;
}

/**
 * A sign-in-only agent read from its audit entry: a known agent by its
 * Connect page name, any other by the name its snapshot kept.
 */
function signedInAgent(
  clientId: string,
  snapshotName: string | null,
): { clientId: string | null; agentName: string } {
  const label = connectAgentLabel(clientId);
  return label
    ? { clientId, agentName: label }
    : { clientId: null, agentName: snapshotName ?? "Unknown agent" };
}

/**
 * Which agent an LLM proxy call came from, best effort, by its
 * `external_agent_id`: a client family the proxy recognises, a Claude client
 * it couldn't tell apart, or the generic client when nothing named it.
 */
function llmAgentIdentity(agent: string | null): {
  clientId: string | null;
  name: string;
} {
  if (!agent) return GENERIC_AGENT;
  if (agent === CLAUDE_CLIENT_ID) return { clientId: null, name: "Claude" };
  const family = clientForExternalAgentIds([agent]);
  return family
    ? { clientId: family.filter, name: family.label }
    : { clientId: agent, name: agent };
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
  llm_proxy_id: string | null;
  llm_proxy_name: string | null;
  include_skills: boolean;
  skill_count: number | null;
  actor_user_id: string | null;
  actor_name: string | null;
  actor_email: string | null;
  oauth_client_id: string | null;
  oauth_client_name: string | null;
  redirect_uris: string[] | null;
  /** Connect client of a sign-in-only agent read from its audit entry. */
  signed_in_client_id: ConnectedClientId | null;
}

/** The ids of an organization's agents, as a subquery. */
function orgAgentIds(organizationId: string): SQL {
  return sql`SELECT ${schema.agentsTable.id} FROM ${schema.agentsTable} WHERE ${schema.agentsTable.organizationId} = ${organizationId}`;
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
