import type { archestraApiTypes } from "@archestra/shared";

/**
 * Organization-wide LLM usage for the Costs and My Usage pages.
 *
 * Everything is derived from one hourly activity curve (work-hours peak,
 * quiet weekends, a few spiky days, adoption growing over time) so the
 * endpoints reconcile: model rows sum to the KPI tiles, people sum to slightly
 * less (shared keys carry unattributed traffic), keys and access methods split
 * the same totals. Values are pseudo-random but seeded by entity and time, so a
 * reload shows the same picture and the window always ends "now".
 */

type CostStatistics = archestraApiTypes.GetCostStatisticsResponses["200"];
type ProxyCostStatistics =
  archestraApiTypes.GetProxyCostStatisticsResponses["200"];
type UserStatistics = archestraApiTypes.GetUserStatisticsResponses["200"];
type UserStatisticsRow = UserStatistics["data"][number];
type TeamStatistics = archestraApiTypes.GetTeamStatisticsResponses["200"];
type AgentStatistics = archestraApiTypes.GetAgentStatisticsResponses["200"];
type AppUsage = archestraApiTypes.GetAppUsageResponses["200"];
type SkillUsage = archestraApiTypes.GetSkillUsageResponses["200"];
type ToolCallUsage = archestraApiTypes.GetMcpToolCallUsageResponses["200"];
type AppStatistics = archestraApiTypes.GetAppStatisticsResponses["200"];
type SkillStatistics = archestraApiTypes.GetSkillStatisticsResponses["200"];
type MyStatistics = archestraApiTypes.GetMyStatisticsResponses["200"];
type MyUsageBreakdown = archestraApiTypes.GetMyUsageBreakdownResponses["200"];
type TimePoint = CostStatistics["models"][number]["timeSeries"][number];
type AuthMethod = ProxyCostStatistics["methods"][number]["authMethod"];
type Pagination = AppUsage["pagination"];

// ===== endpoint builders =====

/** `GET /api/statistics/costs` — model leaderboard, cost tiles, people. */
export function costStatisticsFor(query: URLSearchParams): CostStatistics {
  const org = orgFacts(query.get("timeframe"));
  const users = userFacts(query.get("timeframe"));
  const totalBilled = sum(org.models.map((m) => sumUsage(m.points).billedCost));
  const models = org.models
    .map(({ spec, points }) => {
      const total = sumUsage(points);
      return {
        model: spec.id,
        requests: total.requests,
        inputTokens: total.inputTokens,
        outputTokens: total.outputTokens,
        cacheReadTokens: total.cacheReadTokens,
        cacheWriteTokens: total.cacheWriteTokens,
        totalTokens: reportedTokens(total),
        cost: money(total.billedCost),
        percentage: totalBilled
          ? round2((total.billedCost / totalBilled) * 100)
          : 0,
        timeSeries: seriesOf(org.window, points),
      };
    })
    .filter((m) => m.requests > 0)
    .sort((a, b) => b.cost - a.cost || b.requests - a.requests);

  const savingsSeries = org.window.buckets.map((bucket, i) => {
    let actualCost = 0;
    let subscriptionCost = 0;
    let cacheSavings = 0;
    for (const { spec, points } of org.models) {
      const p = points[i];
      actualCost += p.billedCost;
      subscriptionCost += p.subscriptionCost;
      cacheSavings +=
        ((p.cacheReadTokens * spec.inPrice * 0.9) / 1e6) *
        (1 - spec.subscription);
    }
    // Optimization rules routed a slice of traffic to cheaper models.
    const modelSwapSavings = actualCost * 0.06;
    return {
      timestamp: iso(bucket.start),
      baselineCost: money(actualCost + cacheSavings + modelSwapSavings),
      actualCost: money(actualCost),
      cacheSavings: money(cacheSavings),
      subscriptionCost: money(subscriptionCost),
    };
  });
  const totalBaselineCost = sum(savingsSeries.map((p) => p.baselineCost));
  const totalActualCost = sum(savingsSeries.map((p) => p.actualCost));

  return {
    models,
    costSavings: {
      totalBaselineCost: money(totalBaselineCost),
      totalActualCost: money(totalActualCost),
      totalSavings: money(totalBaselineCost - totalActualCost),
      totalSubscriptionCost: money(
        sum(savingsSeries.map((p) => p.subscriptionCost)),
      ),
      totalCacheSavings: money(sum(savingsSeries.map((p) => p.cacheSavings))),
      timeSeries: savingsSeries,
    },
    activeUsers: users.users.filter((u) => totalOf(u).requests > 0).length,
  };
}

/** `GET /api/statistics/llm-proxy` — spend by access method and key. */
export function proxyCostStatisticsFor(
  query: URLSearchParams,
): ProxyCostStatistics {
  const { window, slices } = proxyFacts(query.get("timeframe"));
  const authMethod = query.get("authMethod");
  const credentialId = query.get("credentialId");
  const limit = intParam(query, "limit", 20);
  const offset = intParam(query, "offset", 0);

  const selected = slices.filter(
    (s) =>
      (!authMethod || s.authMethod === authMethod) &&
      (!credentialId || s.credentialId === credentialId),
  );
  const methods = new Map<AuthMethod, Usage>();
  for (const slice of selected) {
    methods.set(
      slice.authMethod,
      addUsage(methods.get(slice.authMethod) ?? emptyUsage(), slice.total),
    );
  }
  const credentials = selected
    .map((s) => ({
      ...proxyUsage(s.total),
      authMethod: s.authMethod,
      credentialId: s.credentialId,
      credentialName: s.credentialName,
    }))
    .filter((c) => c.requests > 0)
    .sort((a, b) => b.billedCost - a.billedCost || b.requests - a.requests);

  const timeSeries = window.buckets
    .map((bucket, i) => ({
      ...proxyUsage(
        selected.reduce((acc, s) => addUsage(acc, s.points[i]), emptyUsage()),
      ),
      timestamp: iso(bucket.start),
    }))
    .filter((p) => p.requests > 0);

  return {
    totals: proxyUsage(
      selected.reduce((acc, s) => addUsage(acc, s.total), emptyUsage()),
    ),
    timeSeries,
    methods: [...methods.entries()]
      .map(([method, usage]) => ({ ...proxyUsage(usage), authMethod: method }))
      .filter((m) => m.requests > 0)
      .sort((a, b) => b.billedCost - a.billedCost || b.requests - a.requests),
    credentials: credentials.slice(offset, offset + limit),
    pagination: { limit, offset, total: credentials.length },
  };
}

/** `GET /api/statistics/users` — per-person usage, paginated. */
export function userStatisticsFor(query: URLSearchParams): UserStatistics {
  const facts = userFacts(query.get("timeframe"));
  const includeTimeSeries = query.get("includeTimeSeries") === "true";
  const includeModels = query.get("includeModels") === "true";
  const includeModelTimeSeries = query.get("includeModelTimeSeries") === "true";
  const sortBy = query.get("sortBy") ?? "totalTokens";
  const direction = query.get("sortDirection") === "asc" ? 1 : -1;

  const rows = facts.users
    .map((user) =>
      userRow(facts.window, user, {
        includeTimeSeries,
        includeModels,
        includeModelTimeSeries,
      }),
    )
    .filter((row) => row.requests > 0)
    .sort((a, b) => direction * compareUsers(a, b, sortBy));
  return paginate(rows, query);
}

/** `GET /api/statistics/teams`. */
export function teamStatisticsFor(query: URLSearchParams): TeamStatistics {
  const facts = userFacts(query.get("timeframe"));
  return TEAMS.map((team) => {
    const members = facts.users.filter((u) => u.spec.team === team.id);
    const points = facts.window.buckets.map((_, i) =>
      members.reduce(
        (acc, u) =>
          u.models.reduce((inner, m) => addUsage(inner, m.points[i]), acc),
        emptyUsage(),
      ),
    );
    const total = sumUsage(points);
    return {
      teamId: team.id,
      teamName: team.name,
      members: USERS.filter((u) => u.team === team.id).length,
      agents: team.agents,
      requests: total.requests,
      inputTokens: total.inputTokens,
      outputTokens: total.outputTokens,
      cacheReadTokens: total.cacheReadTokens,
      cacheWriteTokens: total.cacheWriteTokens,
      totalTokens: reportedTokens(total),
      cost: money(total.billedCost),
      timeSeries: seriesOf(facts.window, points),
    };
  }).sort((a, b) => b.cost - a.cost);
}

/** `GET /api/statistics/agents`. */
export function agentStatisticsFor(query: URLSearchParams): AgentStatistics {
  const org = orgFacts(query.get("timeframe"));
  const llmAgents = AGENTS.filter((a) => a.llmWeight > 0);
  const series = llmAgents.map(() => [] as Usage[]);
  org.window.buckets.forEach((bucket, i) => {
    const raw = llmAgents.map(
      (a) => a.llmWeight * (0.7 + 0.6 * rand("agent", a.id, bucket.start)),
    );
    const norm = sum(raw);
    llmAgents.forEach((agent, k) => {
      series[k].push(
        scaleUsage(
          org.totals[i],
          (raw[k] / norm) * 0.74,
          `agent|${agent.id}|${bucket.start}`,
        ),
      );
    });
  });
  return llmAgents
    .map((agent, k) => {
      const total = sumUsage(series[k]);
      return {
        agentId: agent.id,
        agentName: agent.name,
        agentType: agent.type,
        teamName: teamName(agent.team),
        requests: total.requests,
        inputTokens: total.inputTokens,
        outputTokens: total.outputTokens,
        cacheReadTokens: total.cacheReadTokens,
        cacheWriteTokens: total.cacheWriteTokens,
        totalTokens: reportedTokens(total),
        cost: money(total.billedCost),
        timeSeries: seriesOf(org.window, series[k]),
      };
    })
    .filter((a) => a.requests > 0)
    .sort((a, b) => b.cost - a.cost);
}

/** `GET /api/statistics/app-usage` — grouped by any of day, appId, userId. */
export function appUsageFor(query: URLSearchParams): AppUsage {
  // Grouped once per query; the explorer then pages through it.
  const { rows, totals } = memo(`app-usage:${groupingKey(query)}`, () => {
    const dims = groupByParam(query);
    const cells = appCells(query.get("timeframe")).filter(
      (c) =>
        matchesUser(c.user, query) &&
        (!query.get("appId") || c.app.id === query.get("appId")),
    );
    const groups = new Map<string, AppUsage["data"][number]>();
    for (const cell of cells) {
      const key = [
        dims.has("day") ? cell.day : "",
        dims.has("appId") ? cell.app.id : "",
        dims.has("userId") ? cell.user.id : "",
      ].join("|");
      let row = groups.get(key);
      if (!row) {
        row = {
          ...(dims.has("day") ? { day: cell.day } : {}),
          ...(dims.has("appId")
            ? { appId: cell.app.id, appName: cell.app.name }
            : {}),
          ...(dims.has("userId")
            ? { userId: cell.user.id, userName: cell.user.name }
            : {}),
          ...emptyAppMetrics(),
        };
        groups.set(key, row);
      }
      addAppMetrics(row, cell);
    }
    const rows = [...groups.values()]
      .map((row) => ({
        ...row,
        billedCost: money(row.billedCost),
        subscriptionCost: money(row.subscriptionCost),
      }))
      .sort(
        (a, b) => (a.day ?? "").localeCompare(b.day ?? "") || b.runs - a.runs,
      );
    const totals = emptyAppMetrics();
    for (const cell of cells) addAppMetrics(totals, cell);
    return {
      rows,
      totals: {
        ...totals,
        billedCost: money(totals.billedCost),
        subscriptionCost: money(totals.subscriptionCost),
      },
    };
  });
  return { ...paginate(rows, query), totals };
}

/** `GET /api/statistics/skill-usage` — grouped by any of day, skillId, userId. */
export function skillUsageFor(query: URLSearchParams): SkillUsage {
  // Grouped once per query; the explorer then pages through it.
  const { rows, totals } = memo(`skill-usage:${groupingKey(query)}`, () => {
    const dims = groupByParam(query);
    const cells = skillCells(query.get("timeframe")).filter(
      (c) =>
        matchesUser(c.user, query) &&
        (!query.get("skillId") || c.skill.id === query.get("skillId")),
    );
    const groups = new Map<
      string,
      { row: SkillUsage["data"][number]; users: Set<string> }
    >();
    for (const cell of cells) {
      const key = [
        dims.has("day") ? cell.day : "",
        dims.has("skillId") ? cell.skill.id : "",
        dims.has("userId") ? cell.user.id : "",
      ].join("|");
      let group = groups.get(key);
      if (!group) {
        group = {
          row: {
            ...(dims.has("day") ? { day: cell.day } : {}),
            ...(dims.has("skillId")
              ? { skillId: cell.skill.id, skillName: cell.skill.name }
              : {}),
            ...(dims.has("userId")
              ? { userId: cell.user.id, userName: cell.user.name }
              : {}),
            activations: 0,
            contextTokens: 0,
            users: 0,
          },
          users: new Set(),
        };
        groups.set(key, group);
      }
      group.row.activations += cell.activations;
      group.row.contextTokens += cell.contextTokens;
      group.users.add(cell.user.id);
    }
    const rows = [...groups.values()]
      .map(({ row, users }) => ({ ...row, users: users.size }))
      .sort(
        (a, b) =>
          (a.day ?? "").localeCompare(b.day ?? "") ||
          b.activations - a.activations,
      );
    return {
      rows,
      totals: {
        activations: sum(cells.map((c) => c.activations)),
        contextTokens: sum(cells.map((c) => c.contextTokens)),
        users: new Set(cells.map((c) => c.user.id)).size,
      },
    };
  });
  return { ...paginate(rows, query), totals };
}

/**
 * `GET /api/statistics/mcp-tool-calls` — grouped by any of day, mcpServerName,
 * toolName, userId, agentId.
 */
export function toolCallUsageFor(query: URLSearchParams): ToolCallUsage {
  // Grouped once per query; the explorer then pages through it.
  const { rows, totals } = memo(`tool-usage:${groupingKey(query)}`, () => {
    const dims = groupByParam(query);
    const cells = toolCells(query.get("timeframe")).filter(
      (c) =>
        matchesUser(c.user, query) &&
        (!query.get("mcpServerName") ||
          c.tool.server === query.get("mcpServerName")) &&
        (!query.get("toolName") || c.tool.name === query.get("toolName")),
    );
    const agentFilter = query.get("agentId");
    const byAgent = dims.has("agentId") || agentFilter !== null;
    const groups = new Map<
      string,
      { row: ToolCallUsage["data"][number]; calls: number; errors: number }
    >();
    for (const cell of cells) {
      const agents = byAgent
        ? agentsForServer(cell.tool.server).filter(
            (a) => !agentFilter || a.agent.id === agentFilter,
          )
        : [{ agent: null, share: 1 }];
      for (const { agent, share } of agents) {
        const key = [
          dims.has("day") ? cell.day : "",
          dims.has("mcpServerName") ? cell.tool.server : "",
          dims.has("toolName") ? cell.tool.name : "",
          dims.has("userId") ? cell.user.id : "",
          dims.has("agentId") ? (agent?.id ?? "") : "",
        ].join("|");
        let group = groups.get(key);
        if (!group) {
          group = {
            row: {
              ...(dims.has("day") ? { day: cell.day } : {}),
              ...(dims.has("mcpServerName") || dims.has("toolName")
                ? { mcpServerName: cell.tool.server }
                : {}),
              ...(dims.has("toolName") ? { toolName: cell.tool.name } : {}),
              ...(dims.has("userId")
                ? { userId: cell.user.id, userName: cell.user.name }
                : {}),
              ...(dims.has("agentId") && agent
                ? { agentId: agent.id, agentName: agent.name }
                : {}),
              ...(dims.has("appId") ? { appId: null, appName: null } : {}),
              calls: 0,
              errors: 0,
            },
            calls: 0,
            errors: 0,
          };
          groups.set(key, group);
        }
        group.calls += cell.calls * share;
        group.errors += cell.errors * share;
      }
    }
    const rows = [...groups.entries()]
      .map(([key, { row, calls, errors }]) => {
        const rounded = roundCount(calls, "tool-row", key);
        return {
          ...row,
          calls: rounded,
          errors: Math.min(rounded, roundCount(errors, "tool-err", key)),
        };
      })
      .filter((row) => row.calls > 0)
      .sort(
        (a, b) => (a.day ?? "").localeCompare(b.day ?? "") || b.calls - a.calls,
      );
    return {
      rows,
      totals: {
        calls: sum(rows.map((r) => r.calls)),
        errors: sum(rows.map((r) => r.errors)),
      },
    };
  });
  return { ...paginate(rows, query), totals };
}

/** `GET /api/statistics/apps` — build vs runtime cost per app. */
export function appStatisticsFor(query: URLSearchParams): AppStatistics {
  const timeframe = query.get("timeframe");
  const window = resolveWindow(timeframe);
  const org = orgFacts(timeframe);
  const cells = appCells(timeframe);
  const rows = APPS.map((app) => {
    const own = cells.filter((c) => c.app.id === app.id);
    const metrics = emptyAppMetrics();
    for (const cell of own) addAppMetrics(metrics, cell);
    const createdAt = Date.now() - app.createdDaysAgo * DAY;
    const built =
      app.build !== null &&
      createdAt >= window.start &&
      createdAt <= window.end;
    const buildCost = built && app.build ? app.build.cost : 0;
    const runtimeCost = money(metrics.billedCost);
    const chat = money(metrics.runs * CHAT_BASELINE_COST_PER_SESSION);
    return {
      appId: app.id,
      appName: app.name,
      authorName: USERS[app.author].name,
      createdAt: iso(createdAt),
      buildRequests: built && app.build ? app.build.requests : 0,
      buildInputTokens: built && app.build ? app.build.requests * 14_200 : 0,
      buildOutputTokens: built && app.build ? app.build.requests * 2_350 : 0,
      buildCost,
      buildSessionAppCount: app.build?.sharedApps ?? 0,
      hasBuildSession: app.build !== null,
      runtimeLlmRequests: metrics.llmRequests,
      runtimeInputTokens: metrics.inputTokens,
      runtimeOutputTokens: metrics.outputTokens,
      runtimeCost,
      runs: metrics.runs,
      toolCalls: metrics.toolCalls,
      estimatedChatEquivalentCost: chat,
      estimatedNetSavings: money(chat - buildCost - runtimeCost),
    };
  }).filter((row) => row.runs > 0 || row.buildCost > 0);

  const sortBy = query.get("sortBy") ?? "totalCost";
  const direction = query.get("sortDirection") === "asc" ? 1 : -1;
  rows.sort((a, b) => {
    switch (sortBy) {
      case "appName":
        return direction * a.appName.localeCompare(b.appName);
      case "buildCost":
      case "runtimeCost":
      case "runs":
      case "estimatedNetSavings":
        return direction * (a[sortBy] - b[sortBy]);
      default:
        return (
          direction *
          (a.buildCost + a.runtimeCost - b.buildCost - b.runtimeCost)
        );
    }
  });
  const requests = sum(org.totals.map((t) => t.requests));
  return {
    ...paginate(rows, query),
    chatBaselineCostPerSession: CHAT_BASELINE_COST_PER_SESSION,
    chatBaselineSessions: Math.round(requests / 18),
  };
}

/** `GET /api/statistics/skills` — context cost and attributed turn spend. */
export function skillStatisticsFor(query: URLSearchParams): SkillStatistics {
  const cells = skillCells(query.get("timeframe"));
  const rows = SKILLS.map((skill) => {
    const own = cells.filter((c) => c.skill.id === skill.id);
    const activations = sum(own.map((c) => c.activations));
    const attributedRequests = Math.round(activations * skill.turnRequests);
    const lastDay = own.reduce<string | null>(
      (latest, c) => (latest === null || c.day > latest ? c.day : latest),
      null,
    );
    return {
      skillId: skill.id,
      skillName: skill.name,
      activations,
      distinctUsers: new Set(own.map((c) => c.user.id)).size,
      contextTokens: sum(own.map((c) => c.contextTokens)),
      measuredActivations: Math.round(activations * skill.measured),
      attributedSessions: Math.round(activations * 0.82),
      attributedRequests,
      attributedInputTokens: attributedRequests * 21_400,
      attributedOutputTokens: attributedRequests * 1_650,
      attributedCost: money(attributedRequests * skill.costPerRequest),
      lastActivatedAt: lastDay
        ? iso(
            Math.min(
              Date.now() - 4 * MINUTE,
              Date.parse(`${lastDay}T00:00:00Z`) +
                (9 + 9 * rand("skill-last", skill.id)) * HOUR,
            ),
          )
        : null,
    };
  }).filter((row) => row.activations > 0);

  const sortBy = query.get("sortBy") ?? "contextTokens";
  const direction = query.get("sortDirection") === "asc" ? 1 : -1;
  rows.sort((a, b) => {
    switch (sortBy) {
      case "skillName":
        return direction * a.skillName.localeCompare(b.skillName);
      case "lastActivatedAt":
        return (
          direction *
          (a.lastActivatedAt ?? "").localeCompare(b.lastActivatedAt ?? "")
        );
      case "activations":
        return direction * (a.activations - b.activations);
      default:
        return direction * (a.contextTokens - b.contextTokens);
    }
  });
  return paginate(rows, query);
}

/** `GET /api/statistics/me` — the signed-in user's own usage. */
export function myStatisticsFor(query: URLSearchParams): MyStatistics {
  const facts = userFacts(query.get("timeframe"));
  const me = facts.users[0];
  const row = userRow(facts.window, me, {
    includeTimeSeries: false,
    includeModels: true,
    includeModelTimeSeries: true,
  });
  const points = facts.window.buckets.map((_, i) =>
    me.models.reduce((acc, m) => addUsage(acc, m.points[i]), emptyUsage()),
  );
  return {
    requests: row.requests,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    cacheReadTokens: row.cacheReadTokens,
    cacheWriteTokens: row.cacheWriteTokens,
    totalTokens: row.totalTokens,
    billedCost: row.billedCost,
    subscriptionCost: row.subscriptionCost,
    activeDays: row.activeDays,
    lastActiveAt: row.lastActiveAt,
    models: row.models ?? [],
    // Every bucket, zeros included: the personal timeline is one continuous
    // series rather than a set of sparse per-entity rows.
    timeSeries: facts.window.buckets.map((bucket, i) =>
      timePoint(bucket.start, points[i]),
    ),
  };
}

/** `GET /api/statistics/me/breakdown` — clients, token mix, context, sessions. */
export function myUsageBreakdownFor(query: URLSearchParams): MyUsageBreakdown {
  const timeframe = query.get("timeframe");
  const facts = userFacts(timeframe);
  const me = facts.users[0];
  const total = totalOf(me);
  const totalCost = total.billedCost + total.subscriptionCost;

  const clients = CLIENTS.map((client) => {
    const usage = splitUsage(total, client.requests, client.billed, {
      subscription: client.subscription,
      seed: `client|${client.label}|${timeframe}`,
    });
    return {
      client: client.label,
      requests: usage.requests,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadTokens: usage.cacheReadTokens,
      cacheWriteTokens: usage.cacheWriteTokens,
      totalTokens: reportedTokens(usage),
      percentage: 0,
      billedCost: money(usage.billedCost),
      subscriptionCost: money(usage.subscriptionCost),
    };
  }).filter((c) => c.requests > 0);
  const clientTokens = sum(clients.map((c) => c.totalTokens));
  for (const client of clients) {
    client.percentage = clientTokens
      ? round2((client.totalTokens / clientTokens) * 100)
      : 0;
  }
  clients.sort((a, b) => b.requests - a.requests);

  let cacheWriteTokens = 0;
  let cacheCost = 0;
  let cacheSavings = 0;
  for (const { spec, points } of me.models) {
    const usage = sumUsage(points);
    cacheWriteTokens += usage.cacheWriteTokens;
    cacheCost +=
      (usage.cacheReadTokens * spec.inPrice * 0.1 +
        usage.cacheWriteTokens * spec.inPrice * 1.25) /
      1e6;
    cacheSavings += (usage.cacheReadTokens * spec.inPrice * 0.9) / 1e6;
  }

  const contextTokens = total.inputTokens + total.cacheReadTokens;
  const bandWeights = CONTEXT_BANDS.map((b) => b.share * b.typicalTokens);
  const bandWeightTotal = sum(bandWeights);
  const contextBuckets = CONTEXT_BANDS.map((band, i) => ({
    bucket: band.bucket,
    requests: Math.round(total.requests * band.share),
    tokens: Math.round((contextTokens * bandWeights[i]) / bandWeightTotal),
    cost: money((totalCost * bandWeights[i]) / bandWeightTotal),
  })).filter((b) => b.requests > 0);

  return {
    tokenMix: {
      freshInputTokens: total.inputTokens,
      cacheReadTokens: total.cacheReadTokens,
      cacheWriteTokens,
      outputTokens: total.outputTokens,
      cacheCost: money(cacheCost),
      cacheSavings: money(cacheSavings),
    },
    clients,
    contextBuckets,
    topSessions: topSessionsFor(facts.window, me, total, timeframe),
    totalCost: money(totalCost),
    unsessionedRequests: Math.round(total.requests * 0.07),
  };
}

// ===== time =====

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

type Bucket = { start: number; end: number };
type Window = { start: number; end: number; buckets: Bucket[] };

// Mirrors the backend's bucket sizes per preset (minute rounded to 5-minute
// steps for 30m/1h, 6-hour steps for 7d, 3-day steps for 90d).
const PRESETS: Record<string, { step: number; count: number }> = {
  "5m": { step: MINUTE, count: 5 },
  "15m": { step: MINUTE, count: 15 },
  "30m": { step: 5 * MINUTE, count: 6 },
  "1h": { step: 5 * MINUTE, count: 12 },
  "24h": { step: HOUR, count: 24 },
  "7d": { step: 6 * HOUR, count: 28 },
  "30d": { step: DAY, count: 30 },
  "90d": { step: 3 * DAY, count: 30 },
  "12m": { step: 7 * DAY, count: 52 },
};

function resolveWindow(timeframe: string | null): Window {
  const now = Date.now();
  if (timeframe?.startsWith("custom:")) {
    const [from, to] = timeframe.slice("custom:".length).split("_");
    const start = Date.parse(from ?? "");
    const end = Math.min(Date.parse(to ?? ""), now);
    if (Number.isFinite(start) && Number.isFinite(end) && end > start) {
      const hours = (end - start) / HOUR;
      const step =
        hours <= 2 ? MINUTE : hours <= 48 ? HOUR : hours <= 720 ? DAY : 7 * DAY;
      const buckets: Bucket[] = [];
      for (
        let t = Math.floor(start / step) * step;
        t < end && buckets.length < 400;
        t += step
      ) {
        buckets.push({ start: t, end: t + step });
      }
      return { start, end, buckets };
    }
  }
  if (timeframe === "all") {
    const today = new Date(now);
    const buckets: Bucket[] = [];
    for (let i = 13; i >= 0; i--) {
      const start = Date.UTC(
        today.getUTCFullYear(),
        today.getUTCMonth() - i,
        1,
      );
      const end = Date.UTC(
        today.getUTCFullYear(),
        today.getUTCMonth() - i + 1,
        1,
      );
      buckets.push({ start, end });
    }
    return { start: buckets[0].start, end: now, buckets };
  }
  const preset = PRESETS[timeframe ?? ""] ?? PRESETS["24h"];
  const last = Math.floor(now / preset.step) * preset.step;
  const buckets = Array.from({ length: preset.count }, (_, i) => {
    const start = last - (preset.count - 1 - i) * preset.step;
    return { start, end: start + preset.step };
  });
  return { start: buckets[0].start, end: now, buckets };
}

function windowDays(window: Window) {
  const days: { day: string; index: number; volume: number }[] = [];
  for (
    let index = Math.floor(window.start / DAY);
    index <= Math.floor((window.end - 1) / DAY);
    index++
  ) {
    days.push({
      day: iso(index * DAY).slice(0, 10),
      index,
      volume: activity(
        Math.max(window.start, index * DAY),
        Math.min(window.end, (index + 1) * DAY),
      ),
    });
  }
  return days;
}

/** Expected organization-wide LLM requests between two instants. */
function activity(from: number, to: number): number {
  let total = 0;
  for (let t = Math.floor(from / HOUR) * HOUR; t < to; t += HOUR) {
    const overlap = Math.min(to, t + HOUR) - Math.max(from, t);
    if (overlap <= 0) continue;
    // Sub-hour slices (the 5m–1h views) get their own jitter so a minute
    // chart isn't a flat line.
    const jitter =
      overlap < HOUR
        ? 0.55 + 0.9 * rand("minute", Math.floor(from / MINUTE))
        : 1;
    total += hourlyRate(t) * (overlap / HOUR) * jitter;
  }
  return total;
}

function hourlyRate(t: number): number {
  const day = Math.floor(t / DAY);
  const hour = Math.floor((t % DAY) / HOUR);
  const fromPeak = Math.abs(hour - peakHour());
  const curve =
    0.2 + 0.95 * Math.exp(-(Math.min(fromPeak, 24 - fromPeak) ** 2) / 30);
  const daysAgo = Math.max(0, Math.floor(Date.now() / DAY) - day);
  const adoption = Math.max(0.35, 1 - 0.0045 * daysAgo);
  const dayNoise = 0.8 + 0.4 * rand("day", day);
  const spike = rand("spike", day) > 0.9 ? 1.7 + rand("spike-size", day) : 1;
  const hourNoise = 0.8 + 0.4 * rand("hour", Math.floor(t / HOUR));
  return (
    BASE_REQUESTS_PER_HOUR *
    curve *
    (isWeekend(day) ? 0.3 : 1) *
    dayNoise *
    spike *
    adoption *
    hourNoise
  );
}

/*
 * The curve runs on a calendar anchored to "now": today is always a working
 * day and the daily peak is the current hour. Mock pages are looked at live,
 * and on the real calendar a weekend night would leave the default 1-hour view
 * nearly empty. The weekly rhythm is kept, just not on the real weekdays.
 */
function isWeekend(day: number): boolean {
  const weekday = (((day - Math.floor(Date.now() / DAY) + 3) % 7) + 7) % 7;
  return weekday === 0 || weekday === 6;
}

function peakHour(): number {
  return Math.floor((Date.now() % DAY) / HOUR);
}

const BASE_REQUESTS_PER_HOUR = 640;

// ===== usage arithmetic =====

type Usage = {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  billedCost: number;
  subscriptionCost: number;
};

/** Unestimated input + output + cache read + cache write. Mock input is never estimated. */
function reportedTokens(u: Usage): number {
  return (
    u.inputTokens + u.outputTokens + u.cacheReadTokens + u.cacheWriteTokens
  );
}

function emptyUsage(): Usage {
  return {
    requests: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    billedCost: 0,
    subscriptionCost: 0,
  };
}

function addUsage(a: Usage, b: Usage): Usage {
  return {
    requests: a.requests + b.requests,
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
    billedCost: a.billedCost + b.billedCost,
    subscriptionCost: a.subscriptionCost + b.subscriptionCost,
  };
}

function sumUsage(points: Usage[]): Usage {
  return points.reduce(addUsage, emptyUsage());
}

function roundUsage(u: Usage): Usage & { totalTokens: number } {
  return {
    ...u,
    totalTokens: reportedTokens(u),
    billedCost: money(u.billedCost),
    subscriptionCost: money(u.subscriptionCost),
  };
}

/** Proxy usage; the mock data has no model pools, so nothing failed over. */
function proxyUsage(u: Usage) {
  return { ...roundUsage(u), failedOverAttempts: 0 };
}

function scaleUsage(u: Usage, share: number, seed: string): Usage {
  return splitUsage(u, share, share, { subscription: share, seed });
}

/** Split usage with separate shares for volume, metered and subscription cost. */
function splitUsage(
  u: Usage,
  volumeShare: number,
  billedShare: number,
  { subscription, seed }: { subscription: number; seed: string },
): Usage {
  const requests = roundCount(u.requests * volumeShare, seed);
  if (requests === 0) return emptyUsage();
  return {
    requests,
    inputTokens: Math.round(u.inputTokens * volumeShare),
    outputTokens: Math.round(u.outputTokens * volumeShare),
    cacheReadTokens: Math.round(u.cacheReadTokens * volumeShare),
    cacheWriteTokens: Math.round(u.cacheWriteTokens * volumeShare),
    billedCost: u.billedCost * billedShare,
    subscriptionCost: u.subscriptionCost * subscription,
  };
}

function timePoint(start: number, u: Usage): TimePoint {
  return {
    timestamp: iso(start),
    value: money(u.billedCost),
    requests: u.requests,
    inputTokens: u.inputTokens,
    outputTokens: u.outputTokens,
    cacheReadTokens: u.cacheReadTokens,
    cacheWriteTokens: u.cacheWriteTokens,
    totalTokens: reportedTokens(u),
    billedCost: money(u.billedCost),
    subscriptionCost: money(u.subscriptionCost),
  };
}

/** Sparse series: like the backend, a bucket with no rows has no point. */
function seriesOf(window: Window, points: Usage[]): TimePoint[] {
  return window.buckets
    .map((bucket, i) => timePoint(bucket.start, points[i]))
    .filter((p) => (p.requests ?? 0) > 0);
}

// ===== organization facts =====

type ModelFacts = { spec: ModelSpec; points: Usage[] };
type OrgFacts = { window: Window; models: ModelFacts[]; totals: Usage[] };

function orgFacts(timeframe: string | null): OrgFacts {
  return memo(`org:${timeframe}`, () => {
    const window = resolveWindow(timeframe);
    const volume = window.buckets.map((b) =>
      activity(Math.max(b.start, window.start), Math.min(b.end, window.end)),
    );
    const weightTotal = sum(MODELS.map((m) => m.weight));
    const models = MODELS.map((spec) => ({
      spec,
      points: window.buckets.map((bucket, i) => {
        const mid = (bucket.start + Math.min(bucket.end, window.end)) / 2;
        const expected =
          ((volume[i] * spec.weight) / weightTotal) *
          modelPresence(spec, mid) *
          (0.75 + 0.5 * rand("model", spec.id, bucket.start));
        const requests = roundCount(expected, spec.id, bucket.start);
        return modelUsage(spec, requests, `${spec.id}|${bucket.start}`);
      }),
    }));
    const totals = window.buckets.map((_, i) =>
      models.reduce((acc, m) => addUsage(acc, m.points[i]), emptyUsage()),
    );
    return { window, models, totals };
  });
}

/** Launch ramps and deprecation fades, by days before now. */
function modelPresence(spec: ModelSpec, t: number): number {
  const daysAgo = (Date.now() - t) / DAY;
  if (spec.since !== undefined) {
    const age = spec.since - daysAgo;
    return age <= 0 ? 0 : Math.min(1, age / 4);
  }
  if (spec.fadeFrom !== undefined && daysAgo < spec.fadeFrom) {
    return 0.12 + 0.88 * (daysAgo / spec.fadeFrom);
  }
  return 1;
}

function modelUsage(spec: ModelSpec, requests: number, seed: string): Usage {
  if (requests === 0) return emptyUsage();
  const jitter = (key: string) => 0.82 + 0.36 * rand(seed, key);
  const inputTokens = Math.round(requests * spec.avgIn * jitter("in"));
  const outputTokens = Math.round(requests * spec.avgOut * jitter("out"));
  const cacheReadTokens = Math.round(
    requests * spec.avgCache * jitter("cache"),
  );
  const cacheWriteTokens =
    spec.avgCache > 0
      ? Math.round(inputTokens * 0.18 * jitter("cache-write"))
      : 0;
  const cost =
    (inputTokens * spec.inPrice +
      outputTokens * spec.outPrice +
      cacheReadTokens * spec.inPrice * 0.1 +
      cacheWriteTokens * spec.inPrice * 1.25) /
    1e6;
  return {
    requests,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    billedCost: cost * (1 - spec.subscription),
    subscriptionCost: cost * spec.subscription,
  };
}

// ===== people =====

type UserModelFacts = { spec: ModelSpec; points: Usage[] };
type UserFacts = { spec: UserSpec; models: UserModelFacts[] };

/**
 * Splits each model's traffic across the people who use it that day. 12% stays
 * unattributed (shared provider keys, service traffic), as on a real install.
 */
function userFacts(timeframe: string | null): {
  window: Window;
  users: UserFacts[];
} {
  return memo(`users:${timeframe}`, () => {
    const org = orgFacts(timeframe);
    const users: UserFacts[] = USERS.map((spec) => ({
      spec,
      models: org.models.map((m) => ({ spec: m.spec, points: [] })),
    }));
    org.window.buckets.forEach((bucket, i) => {
      const long = bucket.end - bucket.start > DAY;
      const day = Math.floor(bucket.start / DAY);
      const presence = USERS.map((u) =>
        long ? u.activeProb : isActive(u, day) ? 1 : 0,
      );
      org.models.forEach((model, k) => {
        const weights = USERS.map(
          (u, j) => u.weight * affinity(u, model.spec) * presence[j],
        );
        const denominator = sum(weights);
        users.forEach((user, j) => {
          const share = denominator ? (0.88 * weights[j]) / denominator : 0;
          const usage = scaleUsage(
            model.points[i],
            share,
            `user|${user.spec.id}|${model.spec.id}|${bucket.start}`,
          );
          if (user.spec.subscriptionOnly) {
            usage.subscriptionCost += usage.billedCost;
            usage.billedCost = 0;
          }
          user.models[k].points.push(usage);
        });
      });
    });
    return { window: org.window, users };
  });
}

function isActive(user: UserSpec, day: number): boolean {
  // The signed-in user (My Usage) is always working today.
  if (user === USERS[0] && day === Math.floor(Date.now() / DAY)) return true;
  return (
    rand("active", user.id, day) < user.activeProb * (isWeekend(day) ? 0.25 : 1)
  );
}

function affinity(user: UserSpec, model: ModelSpec): number {
  if (user.subscriptionOnly) return model.subscription > 0 ? 1 : 0;
  const reach = 0.2 + 0.75 * Math.min(1, model.weight / 10);
  if (rand("affinity", user.id, model.id) > reach) return 0;
  return STACK_PREFERENCE[user.stack][model.provider];
}

function totalOf(user: UserFacts): Usage {
  return user.models.reduce(
    (acc, m) => addUsage(acc, sumUsage(m.points)),
    emptyUsage(),
  );
}

function userRow(
  window: Window,
  user: UserFacts,
  options: {
    includeTimeSeries: boolean;
    includeModels: boolean;
    includeModelTimeSeries: boolean;
  },
): UserStatisticsRow {
  const points = window.buckets.map((_, i) =>
    user.models.reduce((acc, m) => addUsage(acc, m.points[i]), emptyUsage()),
  );
  const total = sumUsage(points);
  const totalTokens = reportedTokens(total);
  const activeBuckets = window.buckets.filter((_, i) => points[i].requests > 0);
  const activeDays = new Set<number>();
  for (const bucket of activeBuckets) {
    const days = Math.max(1, Math.round((bucket.end - bucket.start) / DAY));
    const active = Math.max(1, Math.round(days * user.spec.activeProb));
    for (let d = 0; d < active; d++) {
      activeDays.add(Math.floor(bucket.start / DAY) + d);
    }
  }
  const lastBucket = activeBuckets.at(-1);
  return {
    userId: user.spec.id,
    userName: user.spec.name,
    userEmail: user.spec.email,
    requests: total.requests,
    inputTokens: total.inputTokens,
    outputTokens: total.outputTokens,
    cacheReadTokens: total.cacheReadTokens,
    cacheWriteTokens: total.cacheWriteTokens,
    totalTokens,
    billedCost: money(total.billedCost),
    subscriptionCost: money(total.subscriptionCost),
    activeDays: activeDays.size,
    lastActiveAt: lastBucket
      ? iso(
          Math.min(
            window.end - MINUTE,
            lastBucket.start +
              (lastBucket.end - lastBucket.start) *
                rand("last-active", user.spec.id),
          ),
        )
      : null,
    ...(options.includeModels
      ? {
          models: user.models
            .map(({ spec, points: modelPoints }) => {
              const usage = sumUsage(modelPoints);
              const tokens = reportedTokens(usage);
              return {
                model: spec.id,
                requests: usage.requests,
                inputTokens: usage.inputTokens,
                outputTokens: usage.outputTokens,
                cacheReadTokens: usage.cacheReadTokens,
                cacheWriteTokens: usage.cacheWriteTokens,
                totalTokens: tokens,
                percentage: totalTokens
                  ? round2((tokens / totalTokens) * 100)
                  : 0,
                billedCost: money(usage.billedCost),
                subscriptionCost: money(usage.subscriptionCost),
                ...(options.includeModelTimeSeries
                  ? { timeSeries: seriesOf(window, modelPoints) }
                  : {}),
              };
            })
            .filter((m) => m.requests > 0)
            .sort((a, b) => b.totalTokens - a.totalTokens),
        }
      : {}),
    ...(options.includeTimeSeries
      ? { timeSeries: seriesOf(window, points) }
      : {}),
  };
}

function compareUsers(
  a: UserStatisticsRow,
  b: UserStatisticsRow,
  sortBy: string,
): number {
  switch (sortBy) {
    case "requests":
      return a.requests - b.requests;
    case "billedCost":
      return a.billedCost - b.billedCost;
    case "lastActiveAt":
      return (a.lastActiveAt ?? "").localeCompare(b.lastActiveAt ?? "");
    case "userName":
      return a.userName.localeCompare(b.userName);
    default:
      return a.totalTokens - b.totalTokens;
  }
}

function matchesUser(user: UserSpec, query: URLSearchParams): boolean {
  const userId = query.get("userId");
  const teamId = query.get("teamId");
  return (!userId || user.id === userId) && (!teamId || user.team === teamId);
}

function topSessionsFor(
  window: Window,
  me: UserFacts,
  total: Usage,
  timeframe: string | null,
): MyUsageBreakdown["topSessions"] {
  if (total.requests === 0) return [];
  const listCost = total.billedCost + total.subscriptionCost;
  const costPerRequest = listCost / total.requests;
  const tokensPerRequest = reportedTokens(total) / total.requests;
  const models = me.models
    .map((m) => ({ id: m.spec.id, usage: sumUsage(m.points) }))
    .filter((m) => m.usage.requests > 0)
    .sort(
      (a, b) =>
        b.usage.billedCost +
        b.usage.subscriptionCost -
        a.usage.billedCost -
        a.usage.subscriptionCost,
    );
  const span = window.end - window.start;
  return SESSION_SHARES.map((share, i) => {
    const requests = Math.max(1, Math.round(total.requests * share));
    const cost = money(requests * costPerRequest * (1.6 - i * 0.05));
    const client = SESSION_CLIENTS[i % SESSION_CLIENTS.length];
    const durationMinutes = Math.max(
      1,
      Math.min(
        Math.floor(span / MINUTE) - 1,
        Math.round(6 + 230 * rand("session-length", i)),
      ),
    );
    const startedAt =
      window.start +
      (span - durationMinutes * MINUTE) *
        rand("session-start", timeframe ?? "", i);
    return {
      sessionId: uuid(`session|${timeframe}|${i}`),
      requests,
      tokens: Math.round(requests * tokensPerRequest),
      cost,
      // Claude Code and Codex sessions here ride a subscription.
      billedCost:
        client === "Claude Code" || client === "Codex"
          ? money(cost * 0.08)
          : cost,
      startedAt: iso(startedAt),
      lastActiveAt: iso(startedAt + durationMinutes * MINUTE),
      durationMinutes,
      model: models.length ? models[i % Math.min(3, models.length)].id : null,
      client,
    };
  })
    .filter((s) => s.requests <= total.requests)
    .sort((a, b) => b.cost - a.cost);
}

// ===== access methods and keys =====

type ProxySlice = {
  authMethod: AuthMethod;
  credentialId: string | null;
  credentialName: string | null;
  points: Usage[];
  total: Usage;
};

function proxyFacts(timeframe: string | null): {
  window: Window;
  slices: ProxySlice[];
} {
  return memo(`proxy:${timeframe}`, () => {
    const org = orgFacts(timeframe);
    const slices: ProxySlice[] = [];
    for (const method of AUTH_METHODS) {
      const creds = method.credentials.map((c) => ({
        ...c,
        points: [] as Usage[],
      }));
      org.window.buckets.forEach((bucket, i) => {
        const raw = creds.map(
          (c) =>
            c.share * (0.75 + 0.5 * rand("cred", c.name ?? "", bucket.start)),
        );
        const norm = sum(raw);
        creds.forEach((cred, k) => {
          const share = raw[k] / norm;
          cred.points.push(
            splitUsage(
              org.totals[i],
              method.requests * share,
              method.billed * share,
              {
                subscription: method.subscription * share,
                seed: `proxy|${method.method}|${cred.name}|${k}|${bucket.start}`,
              },
            ),
          );
        });
      });
      for (const cred of creds) {
        slices.push({
          authMethod: method.method,
          credentialId: cred.id,
          credentialName: cred.name,
          points: cred.points,
          total: sumUsage(cred.points),
        });
      }
    }
    return { window: org.window, slices };
  });
}

// ===== apps, skills and tool calls =====

type AppCell = {
  day: string;
  app: AppSpec;
  user: UserSpec;
  runs: number;
  toolCalls: number;
  llmRequests: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  billedCost: number;
  subscriptionCost: number;
};
type AppMetrics = Omit<AppCell, "day" | "app" | "user">;

function appCells(timeframe: string | null): AppCell[] {
  return memo(`apps:${timeframe}`, () => {
    const window = resolveWindow(timeframe);
    const weightTotal = sum(APPS.map((a) => a.weight));
    const cells: AppCell[] = [];
    const nowDay = Math.floor(Date.now() / DAY);
    for (const day of windowDays(window)) {
      for (const app of APPS) {
        if (day.index < nowDay - app.createdDaysAgo) continue;
        const audience = audienceOf(`app|${app.id}`, app.reach, app.author);
        for (const { user, share } of audience) {
          const seed = `${app.id}|${user.id}|${day.day}`;
          const expected =
            day.volume *
            APP_RUNS_PER_REQUEST *
            (app.weight / weightTotal) *
            share *
            (isActive(user, day.index) ? 1 : 0.12) *
            (0.6 + 0.8 * rand("app-runs", seed));
          const runs = roundCount(expected, "app", seed);
          if (runs === 0) continue;
          const llmRequests = roundCount(
            runs * app.llmPerRun * (0.7 + 0.6 * rand("app-llm", seed)),
            "app-llm-round",
            seed,
          );
          const cost =
            llmRequests *
            app.costPerLlm *
            (0.75 + 0.5 * rand("app-cost", seed));
          const inputTokens =
            llmRequests * Math.round(5_800 + 3_000 * rand("in", seed));
          const outputTokens =
            llmRequests * Math.round(650 + 500 * rand("out", seed));
          const cacheReadTokens =
            llmRequests * Math.round(1_200 + 800 * rand("cache-read", seed));
          const cacheWriteTokens =
            llmRequests * Math.round(400 + 200 * rand("cache-write", seed));
          cells.push({
            day: day.day,
            app,
            user,
            runs,
            toolCalls: Math.round(
              runs * app.toolsPerRun * (0.7 + 0.6 * rand("app-tools", seed)),
            ),
            llmRequests,
            inputTokens,
            outputTokens,
            cacheReadTokens,
            cacheWriteTokens,
            totalTokens:
              inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens,
            billedCost: cost * (1 - app.subscription),
            subscriptionCost: cost * app.subscription,
          });
        }
      }
    }
    return cells;
  });
}

function emptyAppMetrics(): AppMetrics {
  return {
    runs: 0,
    toolCalls: 0,
    llmRequests: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
    billedCost: 0,
    subscriptionCost: 0,
  };
}

function addAppMetrics(target: AppMetrics, cell: AppMetrics): void {
  target.runs += cell.runs;
  target.toolCalls += cell.toolCalls;
  target.llmRequests += cell.llmRequests;
  target.inputTokens += cell.inputTokens;
  target.outputTokens += cell.outputTokens;
  target.cacheReadTokens += cell.cacheReadTokens;
  target.cacheWriteTokens += cell.cacheWriteTokens;
  target.totalTokens += cell.totalTokens;
  target.billedCost += cell.billedCost;
  target.subscriptionCost += cell.subscriptionCost;
}

type SkillCell = {
  day: string;
  skill: SkillSpec;
  user: UserSpec;
  activations: number;
  contextTokens: number;
};

function skillCells(timeframe: string | null): SkillCell[] {
  return memo(`skills:${timeframe}`, () => {
    const window = resolveWindow(timeframe);
    const weightTotal = sum(SKILLS.map((s) => s.weight));
    const cells: SkillCell[] = [];
    for (const day of windowDays(window)) {
      for (const skill of SKILLS) {
        for (const { user, share } of audienceOf(
          `skill|${skill.id}`,
          skill.reach,
        )) {
          const seed = `${skill.id}|${user.id}|${day.day}`;
          const expected =
            day.volume *
            SKILL_ACTIVATIONS_PER_REQUEST *
            (skill.weight / weightTotal) *
            share *
            (isActive(user, day.index) ? 1 : 0.1) *
            (0.6 + 0.8 * rand("skill-act", seed));
          const activations = roundCount(expected, "skill", seed);
          if (activations === 0) continue;
          cells.push({
            day: day.day,
            skill,
            user,
            activations,
            contextTokens: Math.round(
              activations *
                skill.contextTokens *
                (0.85 + 0.3 * rand("skill-ctx", seed)),
            ),
          });
        }
      }
    }
    return cells;
  });
}

type ToolCell = {
  day: string;
  tool: ToolSpec;
  user: UserSpec;
  calls: number;
  errors: number;
};

function toolCells(timeframe: string | null): ToolCell[] {
  return memo(`tools:${timeframe}`, () => {
    const window = resolveWindow(timeframe);
    const weightTotal = sum(TOOLS.map((t) => t.weight));
    const audiences = new Map(
      MCP_SERVERS.map((s) => [s.name, audienceOf(`server|${s.name}`, s.reach)]),
    );
    const cells: ToolCell[] = [];
    for (const day of windowDays(window)) {
      for (const tool of TOOLS) {
        for (const { user, share } of audiences.get(tool.server) ?? []) {
          const seed = `${tool.server}/${tool.name}|${user.id}|${day.day}`;
          const expected =
            day.volume *
            TOOL_CALLS_PER_REQUEST *
            (tool.weight / weightTotal) *
            share *
            (isActive(user, day.index) ? 1 : 0.08) *
            (0.6 + 0.8 * rand("tool-calls", seed));
          const calls = roundCount(expected, "tool", seed);
          if (calls === 0) continue;
          cells.push({
            day: day.day,
            tool,
            user,
            calls,
            errors: roundCount(
              calls * tool.errorRate * (0.4 + 1.2 * rand("tool-err", seed)),
              "tool-err-round",
              seed,
            ),
          });
        }
      }
    }
    return cells;
  });
}

/** Which agents call a server's tools, and in what proportion. */
function agentsForServer(server: string) {
  return memo(`server-agents:${server}`, () => {
    const candidates = AGENTS.filter(
      (a) =>
        a.toolWeight > 0 &&
        (a.type === "mcp_gateway" || rand("agent-server", a.id, server) < 0.45),
    );
    const total = sum(candidates.map((a) => a.toolWeight));
    return candidates.map((agent) => ({
      agent,
      share: agent.toolWeight / total,
    }));
  });
}

/**
 * The people who use an app, skill or server: a seeded subset of the roster,
 * weighted toward heavier users. The author (when given) always appears.
 */
function audienceOf(seed: string, reach: number, author?: number) {
  return memo(`audience:${seed}`, () => {
    const members = USERS.filter(
      (u, i) =>
        !u.subscriptionOnly &&
        (i === author || rand("audience", seed, u.id) < reach),
    );
    const weights = members.map((u) => u.weight ** 0.6);
    const total = sum(weights);
    return members.map((user, i) => ({ user, share: weights[i] / total }));
  });
}

// ===== helpers =====

/** A query's identity without its page, so every page shares one grouping. */
function groupingKey(query: URLSearchParams): string {
  return [...query.entries()]
    .filter(([key]) => key !== "limit" && key !== "offset")
    .map(([key, value]) => `${key}=${value}`)
    .sort()
    .join("&");
}

function groupByParam(query: URLSearchParams): Set<string> {
  return new Set(
    query
      .getAll("groupBy")
      .flatMap((value) => value.split(","))
      .map((value) => value.trim())
      .filter(Boolean),
  );
}

function intParam(query: URLSearchParams, key: string, fallback: number) {
  const value = Number(query.get(key));
  return query.has(key) && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : fallback;
}

function paginate<T>(
  rows: T[],
  query: URLSearchParams,
): { data: T[]; pagination: Pagination } {
  const limit = Math.max(1, intParam(query, "limit", 20));
  const offset = intParam(query, "offset", 0);
  const total = rows.length;
  return {
    data: rows.slice(offset, offset + limit),
    pagination: {
      currentPage: Math.floor(offset / limit) + 1,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
      hasNext: offset + limit < total,
      hasPrev: offset > 0,
    },
  };
}

const memoCache = new Map<string, unknown>();

/** Recompute at most once a minute per key, so pagination stays consistent. */
function memo<T>(key: string, build: () => T): T {
  const fullKey = `${key}@${Math.floor(Date.now() / MINUTE)}`;
  if (memoCache.has(fullKey)) return memoCache.get(fullKey) as T;
  const value = build();
  memoCache.set(fullKey, value);
  while (memoCache.size > 60) {
    const oldest = memoCache.keys().next().value;
    if (oldest === undefined) break;
    memoCache.delete(oldest);
  }
  return value;
}

/** Deterministic value in [0, 1) for a tuple of seeds. */
function rand(...parts: (string | number)[]): number {
  const text = parts.join("|");
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  h ^= h >>> 16;
  h = Math.imul(h, 2246822507);
  h ^= h >>> 13;
  h = Math.imul(h, 3266489909);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** Round a fractional expected count, carrying the fraction as a seeded coin. */
function roundCount(value: number, ...seed: (string | number)[]): number {
  if (!(value > 0)) return 0;
  const whole = Math.floor(value);
  return whole + (rand("round", ...seed) < value - whole ? 1 : 0);
}

function uuid(seed: string): string {
  const hex = Array.from({ length: 4 }, (_, i) =>
    Math.floor(rand("uuid", seed, i) * 0xffffffff)
      .toString(16)
      .padStart(8, "0"),
  ).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function money(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function teamName(id: string): string {
  return TEAMS.find((t) => t.id === id)?.name ?? "Unassigned";
}

// ===== roster =====

type Provider = "anthropic" | "openai" | "google" | "other";

type ModelSpec = {
  id: string;
  provider: Provider;
  weight: number;
  inPrice: number;
  outPrice: number;
  avgIn: number;
  avgOut: number;
  avgCache: number;
  /** Fraction of this model's traffic served by a subscription credential. */
  subscription: number;
  /** Launched this many days ago; ramps up over four days. */
  since?: number;
  /** Being replaced; declines from this many days ago to now. */
  fadeFrom?: number;
};

function model(
  id: string,
  provider: Provider,
  weight: number,
  [inPrice, outPrice]: [number, number],
  [avgIn, avgOut, avgCache]: [number, number, number],
  subscription = 0,
  lifecycle: { since?: number; fadeFrom?: number } = {},
): ModelSpec {
  return {
    id,
    provider,
    weight,
    inPrice,
    outPrice,
    avgIn,
    avgOut,
    avgCache,
    subscription,
    ...lifecycle,
  };
}

const MODELS: ModelSpec[] = [
  model(
    "claude-opus-4-7",
    "anthropic",
    16,
    [15, 75],
    [9_000, 1_500, 48_000],
    0.55,
  ),
  model(
    "claude-sonnet-5",
    "anthropic",
    24,
    [3, 15],
    [11_000, 1_700, 62_000],
    0.5,
    { since: 18 },
  ),
  model(
    "claude-sonnet-4-6",
    "anthropic",
    16,
    [3, 15],
    [10_000, 1_500, 52_000],
    0.45,
    { fadeFrom: 18 },
  ),
  model("gpt-5.6-sol", "openai", 12, [2.5, 12], [8_000, 1_300, 30_000], 0.3),
  model("gemini-2.5-flash", "google", 10, [0.3, 2.5], [6_000, 800, 12_000]),
  model("gpt-5.6-mini", "openai", 9, [0.4, 1.6], [4_200, 700, 9_000]),
  model("claude-haiku-4-5", "anthropic", 8, [1, 5], [3_800, 600, 8_000], 0.2),
  model("text-embedding-3-large", "openai", 7, [0.13, 0], [1_800, 0, 0]),
  model("gpt-5.6-codex", "openai", 5, [1.25, 10], [12_000, 2_200, 70_000], 0.7),
  model("gemini-2.5-pro", "google", 5, [1.25, 10], [14_000, 1_600, 26_000]),
  model("openrouter/auto", "other", 3, [2, 10], [5_000, 900, 0]),
  model(
    "bedrock/us.anthropic.claude-sonnet-4-6-20260115-v1:0",
    "anthropic",
    3,
    [3, 15],
    [9_000, 1_200, 30_000],
  ),
  model("gpt-5.6-nano", "openai", 3, [0.05, 0.4], [2_500, 300, 0]),
  model("text-embedding-3-small", "openai", 2.5, [0.02, 0], [1_200, 0, 0]),
  model(
    "gemini-3-pro-preview",
    "google",
    2.2,
    [2, 12],
    [16_000, 2_000, 20_000],
    0,
    { since: 9 },
  ),
  model(
    "vertex_ai/gemini-2.5-flash-lite",
    "google",
    2,
    [0.1, 0.4],
    [3_000, 400, 0],
  ),
  model(
    "openrouter/deepseek/deepseek-v3.2-exp",
    "other",
    1.6,
    [0.27, 0.41],
    [7_000, 1_100, 0],
  ),
  model(
    "claude-opus-4-1",
    "anthropic",
    1.5,
    [15, 75],
    [8_000, 1_200, 30_000],
    0.3,
    { fadeFrom: 40 },
  ),
  model("azure/gpt-4.1-2025-04-14", "openai", 1.4, [2, 8], [5_000, 800, 0]),
  model(
    "openrouter/qwen/qwen3-coder-480b-a35b-instruct",
    "other",
    1.2,
    [0.4, 1.6],
    [9_000, 1_500, 0],
  ),
  model("ollama/qwen2.5-coder:32b", "other", 1.1, [0, 0], [6_000, 900, 0]),
  model("mistral-large-2511", "other", 1, [2, 6], [4_000, 700, 0]),
  model("voyage-3-large", "other", 1, [0.18, 0], [1_500, 0, 0]),
  model("grok-4-fast-reasoning", "other", 0.8, [0.2, 0.5], [6_000, 1_200, 0]),
  model(
    "llama-4-maverick-17b-128e-instruct",
    "other",
    0.7,
    [0.2, 0.6],
    [4_000, 700, 0],
  ),
  model(
    "vllm/meta-llama/Llama-3.3-70B-Instruct",
    "other",
    0.6,
    [0, 0],
    [3_500, 600, 0],
  ),
  model("o4-deep-research", "openai", 0.5, [10, 40], [30_000, 6_000, 0]),
  model(
    "openrouter/moonshotai/kimi-k2-0905",
    "other",
    0.5,
    [0.6, 2.5],
    [8_000, 1_300, 0],
  ),
  model("cohere/command-a-03-2025", "other", 0.4, [2.5, 10], [3_000, 600, 0]),
  model(
    "bedrock/amazon.nova-pro-v1:0",
    "other",
    0.4,
    [0.8, 3.2],
    [3_000, 500, 0],
  ),
  model(
    "perplexity/sonar-reasoning-pro",
    "other",
    0.35,
    [2, 8],
    [2_000, 1_200, 0],
  ),
  model("o3-pro", "openai", 0.3, [20, 80], [12_000, 3_000, 0]),
  model("gpt-image-1", "openai", 0.25, [5, 40], [800, 4_000, 0]),
];

type Stack = "anthropic" | "openai" | "google" | "mixed";

const STACK_PREFERENCE: Record<Stack, Record<Provider, number>> = {
  anthropic: { anthropic: 1.8, openai: 0.35, google: 0.3, other: 0.5 },
  openai: { anthropic: 0.4, openai: 1.8, google: 0.4, other: 0.6 },
  google: { anthropic: 0.4, openai: 0.5, google: 1.9, other: 0.5 },
  mixed: { anthropic: 1, openai: 1, google: 1, other: 1.3 },
};

const TEAMS = [
  { id: "team-platform", name: "Platform Engineering", agents: 6 },
  { id: "team-data", name: "Data Science", agents: 4 },
  { id: "team-devex", name: "Developer Experience", agents: 5 },
  { id: "team-support", name: "Customer Support", agents: 3 },
  { id: "team-growth", name: "Growth & Marketing", agents: 2 },
  { id: "team-security", name: "Security", agents: 2 },
];

type UserSpec = {
  id: string;
  name: string;
  email: string;
  team: string;
  weight: number;
  activeProb: number;
  stack: Stack;
  /** Uses only a Claude/ChatGPT subscription, so nothing is metered. */
  subscriptionOnly: boolean;
};

// Index 0 is the signed-in user on My Usage: a heavy Claude Code user.
const PEOPLE = [
  "Alex Rivera",
  "Priya Natarajan",
  "Jordan Okafor",
  "Mei Tanaka",
  "Samuel Brandt",
  "Lucia Moreno",
  "Ethan Kowalczyk",
  "Aaliyah Grant",
  "Noah Lindgren",
  "Sofia Esposito",
  "Daniel Achterberg",
  "Hana Yoshida",
  "Marcus Bell",
  "Ines Carvalho",
  "Owen Fitzgerald",
  "Zara Qureshi",
  "Felix Hartmann",
  "Grace Adeyemi",
  "Rohan Mehta",
  "Clara Johansson",
  "Theo Marchetti",
  "Nadia Haddad",
  "Victor Delgado",
  "Elif Demir",
  "Liam O'Brien",
  "Amelia Novak",
  "Kenji Watanabe",
  "Isla Mackenzie",
  "Mateo Silva",
  "Freya Holm",
  "Omar Saleh",
  "Ruby Chen",
  "Henrik Dahl",
  "Tara Singh",
  "Julian Weber",
  "Maya Goldberg",
  "Diego Navarro",
  "Leah Kim",
  "Arjun Iyer",
  "Chloe Dubois",
  "Kofi Mensah",
  "Ava Lindqvist",
  "Ben Carter",
  "Yara Haddad",
  "Pavel Novotny",
  "Nora Fischer",
  "Sam Whitaker",
  "Lena Petrova",
];

const SUBSCRIPTION_ONLY = new Set([6, 13, 22, 35]);
const STACKS: Stack[] = ["anthropic", "anthropic", "mixed", "openai", "google"];

const USERS: UserSpec[] = PEOPLE.map((name, i) => {
  const [first, ...rest] = name.toLowerCase().replace(/'/g, "").split(" ");
  return {
    id: uuid(`user|${name}`),
    name,
    email: `${first}.${rest.join("-")}@example.com`,
    team:
      i === 0
        ? "team-devex"
        : TEAMS[Math.floor(rand("team", name) * TEAMS.length)].id,
    weight:
      (i === 0 ? 2.2 : 1 / (i + 2) ** 0.85) *
      (0.75 + 0.5 * rand("weight", name)),
    activeProb: i === 0 ? 0.97 : Math.max(0.22, 0.96 - i * 0.015),
    stack:
      i === 0
        ? "anthropic"
        : STACKS[Math.floor(rand("stack", name) * STACKS.length)],
    subscriptionOnly: SUBSCRIPTION_ONLY.has(i),
  };
});

type AgentSpec = {
  id: string;
  name: string;
  team: string;
  type: "agent" | "llm_proxy" | "mcp_gateway";
  llmWeight: number;
  toolWeight: number;
};

const AGENTS: AgentSpec[] = [
  {
    name: "Default LLM Proxy",
    team: "team-platform",
    type: "llm_proxy" as const,
    llmWeight: 20,
    toolWeight: 0,
  },
  {
    name: "Default MCP Gateway",
    team: "team-platform",
    type: "mcp_gateway" as const,
    llmWeight: 0,
    toolWeight: 26,
  },
  {
    name: "Research Assistant",
    team: "team-data",
    type: "agent" as const,
    llmWeight: 18,
    toolWeight: 14,
  },
  {
    name: "Support Copilot",
    team: "team-support",
    type: "agent" as const,
    llmWeight: 15,
    toolWeight: 12,
  },
  {
    name: "PR Reviewer",
    team: "team-devex",
    type: "agent" as const,
    llmWeight: 13,
    toolWeight: 16,
  },
  {
    name: "Incident Commander",
    team: "team-platform",
    type: "agent" as const,
    llmWeight: 9,
    toolWeight: 10,
  },
  {
    name: "SQL Analyst",
    team: "team-data",
    type: "agent" as const,
    llmWeight: 8,
    toolWeight: 9,
  },
  {
    name: "Release Notes Writer",
    team: "team-devex",
    type: "agent" as const,
    llmWeight: 5,
    toolWeight: 4,
  },
  {
    name: "Security Triage",
    team: "team-security",
    type: "agent" as const,
    llmWeight: 5,
    toolWeight: 6,
  },
  {
    name: "Campaign Drafts",
    team: "team-growth",
    type: "agent" as const,
    llmWeight: 4,
    toolWeight: 2,
  },
  {
    name: "Onboarding Buddy",
    team: "team-platform",
    type: "agent" as const,
    llmWeight: 3,
    toolWeight: 2,
  },
].map((agent) => ({ ...agent, id: uuid(`agent|${agent.name}`) }));

type CredentialSpec = { id: string | null; name: string | null; share: number };

function keyed(name: string, share: number): CredentialSpec {
  return { id: uuid(`credential|${name}`), name, share };
}

const AUTH_METHODS: {
  method: AuthMethod;
  requests: number;
  billed: number;
  subscription: number;
  credentials: CredentialSpec[];
}[] = [
  {
    method: "virtual_key",
    requests: 0.34,
    billed: 0.46,
    subscription: 0,
    credentials: [
      keyed("ci-eval-runner", 0.24),
      keyed("support-copilot-prod", 0.18),
      keyed("data-platform-etl", 0.14),
      keyed("growth-experiments", 0.1),
      keyed("sales-assist-staging", 0.08),
      keyed("docs-search-indexer", 0.07),
      keyed("security-triage-bot", 0.07),
      keyed("hackathon-2026-team-7", 0.05),
      keyed("legacy-workflow-automations", 0.04),
      keyed("mobile-app-preview", 0.03),
    ],
  },
  {
    method: "oauth_user",
    requests: 0.2,
    billed: 0.04,
    subscription: 0.62,
    credentials: [{ id: null, name: null, share: 1 }],
  },
  {
    method: "provider_key",
    requests: 0.14,
    billed: 0.2,
    subscription: 0,
    credentials: [
      keyed("Anthropic production", 0.55),
      keyed("OpenAI shared", 0.3),
      keyed("Google Vertex (data science)", 0.15),
    ],
  },
  {
    method: "passthrough_virtual_key",
    requests: 0.1,
    billed: 0.04,
    subscription: 0.3,
    credentials: [
      keyed("Claude Code passthrough", 0.7),
      keyed("Codex passthrough", 0.3),
    ],
  },
  {
    method: "personal_token",
    requests: 0.09,
    billed: 0.1,
    subscription: 0.08,
    credentials: [{ id: null, name: null, share: 1 }],
  },
  {
    method: "oauth_client_credentials",
    requests: 0.06,
    billed: 0.1,
    subscription: 0,
    credentials: [
      keyed("ticketing-integration", 0.6),
      keyed("nightly-report-generator", 0.4),
    ],
  },
  {
    method: "jwks",
    requests: 0.04,
    billed: 0.04,
    subscription: 0,
    credentials: [{ id: null, name: "Workload identity (JWKS)", share: 1 }],
  },
  {
    method: "internal",
    requests: 0.02,
    billed: 0.015,
    subscription: 0,
    credentials: [{ id: null, name: null, share: 1 }],
  },
  {
    // Two rows with no identifier: the explorer cannot trend them separately.
    method: "unknown",
    requests: 0.01,
    billed: 0.005,
    subscription: 0,
    credentials: [
      { id: null, name: null, share: 0.7 },
      { id: null, name: null, share: 0.3 },
    ],
  },
];

const CLIENTS: {
  label: string | null;
  requests: number;
  billed: number;
  subscription: number;
}[] = [
  { label: "Claude Code", requests: 0.44, billed: 0.2, subscription: 0.7 },
  { label: "Cursor", requests: 0.21, billed: 0.38, subscription: 0 },
  { label: "Codex", requests: 0.13, billed: 0.05, subscription: 0.3 },
  {
    label: "Agent: Research Assistant",
    requests: 0.09,
    billed: 0.17,
    subscription: 0,
  },
  { label: "OpenCode", requests: 0.05, billed: 0.1, subscription: 0 },
  { label: null, requests: 0.08, billed: 0.1, subscription: 0 },
];

const SESSION_CLIENTS = [
  "Claude Code",
  "Cursor",
  "Claude Code",
  "Codex",
  "Agent: Research Assistant",
  "Claude Code",
  "OpenCode",
  "Cursor",
  "Codex",
  "Claude Code",
];
const SESSION_SHARES = [
  0.061, 0.047, 0.039, 0.033, 0.028, 0.024, 0.02, 0.017, 0.014, 0.012,
];

const CONTEXT_BANDS: {
  bucket: MyUsageBreakdown["contextBuckets"][number]["bucket"];
  share: number;
  typicalTokens: number;
}[] = [
  { bucket: "under32k", share: 0.46, typicalTokens: 14_000 },
  { bucket: "under128k", share: 0.31, typicalTokens: 72_000 },
  { bucket: "under256k", share: 0.15, typicalTokens: 178_000 },
  { bucket: "over256k", share: 0.08, typicalTokens: 310_000 },
];

const APP_RUNS_PER_REQUEST = 0.03;
const SKILL_ACTIVATIONS_PER_REQUEST = 0.05;
const TOOL_CALLS_PER_REQUEST = 0.8;
const CHAT_BASELINE_COST_PER_SESSION = 0.41;

type AppSpec = {
  id: string;
  name: string;
  weight: number;
  author: number;
  createdDaysAgo: number;
  build: { cost: number; requests: number; sharedApps: number } | null;
  toolsPerRun: number;
  llmPerRun: number;
  costPerLlm: number;
  subscription: number;
  reach: number;
};

const APPS: AppSpec[] = [
  {
    name: "Quarterly Revenue Dashboard",
    weight: 16,
    author: 3,
    createdDaysAgo: 52,
    build: { cost: 14.2, requests: 61, sharedApps: 1 },
    toolsPerRun: 6.5,
    llmPerRun: 0,
    costPerLlm: 0,
    subscription: 0,
    reach: 0.55,
  },
  {
    name: "Incident Triage Board",
    weight: 13,
    author: 1,
    createdDaysAgo: 34,
    build: { cost: 22.8, requests: 94, sharedApps: 1 },
    toolsPerRun: 8.2,
    llmPerRun: 1.6,
    costPerLlm: 0.045,
    subscription: 0,
    reach: 0.4,
  },
  {
    name: "PR Review Queue",
    weight: 12,
    author: 0,
    createdDaysAgo: 21,
    build: { cost: 9.6, requests: 40, sharedApps: 1 },
    toolsPerRun: 4.1,
    llmPerRun: 2.4,
    costPerLlm: 0.06,
    subscription: 0.3,
    reach: 0.5,
  },
  {
    name: "Customer Health Tracker",
    weight: 9,
    author: 8,
    createdDaysAgo: 75,
    build: { cost: 17.3, requests: 70, sharedApps: 2 },
    toolsPerRun: 5,
    llmPerRun: 0.8,
    costPerLlm: 0.03,
    subscription: 0,
    reach: 0.35,
  },
  {
    name: "Churn Risk Explorer",
    weight: 6,
    author: 8,
    createdDaysAgo: 75,
    build: { cost: 17.3, requests: 70, sharedApps: 2 },
    toolsPerRun: 3.4,
    llmPerRun: 1.1,
    costPerLlm: 0.028,
    subscription: 0,
    reach: 0.2,
  },
  {
    name: "SQL Playground",
    weight: 8,
    author: 4,
    createdDaysAgo: 64,
    build: null,
    toolsPerRun: 1.6,
    llmPerRun: 1.8,
    costPerLlm: 0.018,
    subscription: 0,
    reach: 0.3,
  },
  {
    name: "Sprint Retro Board",
    weight: 7,
    author: 12,
    createdDaysAgo: 12,
    build: { cost: 5.1, requests: 22, sharedApps: 1 },
    toolsPerRun: 2.2,
    llmPerRun: 0.4,
    costPerLlm: 0.012,
    subscription: 0,
    reach: 0.45,
  },
  {
    name: "On-call Handoff",
    weight: 6,
    author: 1,
    createdDaysAgo: 41,
    build: { cost: 7.9, requests: 31, sharedApps: 1 },
    toolsPerRun: 3.9,
    llmPerRun: 1,
    costPerLlm: 0.02,
    subscription: 0,
    reach: 0.25,
  },
  {
    name: "Support Macro Finder",
    weight: 5,
    author: 21,
    createdDaysAgo: 6,
    build: { cost: 3.2, requests: 15, sharedApps: 1 },
    toolsPerRun: 2.8,
    llmPerRun: 1.3,
    costPerLlm: 0.015,
    subscription: 0,
    reach: 0.3,
  },
  {
    name: "Cost Anomaly Watch",
    weight: 4,
    author: 2,
    createdDaysAgo: 27,
    build: { cost: 11.2, requests: 45, sharedApps: 1 },
    toolsPerRun: 4.4,
    llmPerRun: 0.6,
    costPerLlm: 0.05,
    subscription: 0,
    reach: 0.18,
  },
  {
    name: "Release Notes Builder",
    weight: 3.5,
    author: 6,
    createdDaysAgo: 16,
    build: { cost: 4.4, requests: 18, sharedApps: 1 },
    toolsPerRun: 3,
    llmPerRun: 2,
    costPerLlm: 0.035,
    subscription: 0.5,
    reach: 0.2,
  },
  {
    name: "Hiring Pipeline",
    weight: 3,
    author: 17,
    createdDaysAgo: 9,
    build: { cost: 6.4, requests: 27, sharedApps: 1 },
    toolsPerRun: 2.5,
    llmPerRun: 0,
    costPerLlm: 0,
    subscription: 0,
    reach: 0.12,
  },
].map((app) => ({ ...app, id: uuid(`app|${app.name}`) }));

type SkillSpec = {
  id: string;
  name: string;
  weight: number;
  contextTokens: number;
  reach: number;
  measured: number;
  turnRequests: number;
  costPerRequest: number;
};

const SKILLS: SkillSpec[] = [
  {
    name: "pdf-extraction",
    weight: 14,
    contextTokens: 6_200,
    reach: 0.55,
    measured: 1,
    turnRequests: 5.2,
    costPerRequest: 0.09,
  },
  {
    name: "sql-review",
    weight: 11,
    contextTokens: 4_800,
    reach: 0.3,
    measured: 1,
    turnRequests: 6.8,
    costPerRequest: 0.07,
  },
  {
    name: "brand-voice",
    weight: 9,
    contextTokens: 3_100,
    reach: 0.35,
    measured: 1,
    turnRequests: 3.1,
    costPerRequest: 0.05,
  },
  {
    name: "terraform-plan-review",
    weight: 8,
    contextTokens: 9_400,
    reach: 0.18,
    measured: 0.82,
    turnRequests: 9.5,
    costPerRequest: 0.14,
  },
  {
    name: "incident-postmortem",
    weight: 7,
    contextTokens: 7_700,
    reach: 0.25,
    measured: 1,
    turnRequests: 7.4,
    costPerRequest: 0.12,
  },
  {
    name: "data-viz",
    weight: 7,
    contextTokens: 5_300,
    reach: 0.4,
    measured: 1,
    turnRequests: 4.6,
    costPerRequest: 0.06,
  },
  {
    name: "security-review",
    weight: 6,
    contextTokens: 12_800,
    reach: 0.15,
    measured: 0.74,
    turnRequests: 11.2,
    costPerRequest: 0.18,
  },
  {
    name: "release-notes",
    weight: 5,
    contextTokens: 2_600,
    reach: 0.22,
    measured: 1,
    turnRequests: 2.8,
    costPerRequest: 0.04,
  },
  {
    name: "kubernetes-debug",
    weight: 5,
    contextTokens: 8_900,
    reach: 0.16,
    measured: 1,
    turnRequests: 8.7,
    costPerRequest: 0.11,
  },
  {
    name: "customer-email-tone",
    weight: 4,
    contextTokens: 1_900,
    reach: 0.2,
    measured: 1,
    turnRequests: 2.2,
    costPerRequest: 0.03,
  },
  {
    name: "excel-reporting",
    weight: 3.5,
    contextTokens: 6_800,
    reach: 0.25,
    measured: 0.9,
    turnRequests: 5.6,
    costPerRequest: 0.08,
  },
  {
    name: "api-design-guidelines",
    weight: 3,
    contextTokens: 17_500,
    reach: 0.14,
    measured: 1,
    turnRequests: 6.1,
    costPerRequest: 0.1,
  },
  {
    name: "onboarding-guide",
    weight: 2,
    contextTokens: 4_100,
    reach: 0.3,
    measured: 1,
    turnRequests: 3.4,
    costPerRequest: 0.04,
  },
  {
    name: "legal-redline",
    weight: 1.2,
    contextTokens: 14_300,
    reach: 0.06,
    measured: 1,
    turnRequests: 7.9,
    costPerRequest: 0.16,
  },
].map((skill) => ({ ...skill, id: uuid(`skill|${skill.name}`) }));

type ToolSpec = {
  server: string;
  name: string;
  weight: number;
  errorRate: number;
};

const MCP_SERVERS: {
  name: string;
  reach: number;
  tools: [string, number, number][];
}[] = [
  {
    name: "github",
    reach: 0.4,
    tools: [
      ["search_code", 14, 0.008],
      ["get_pull_request", 11, 0.004],
      ["get_file_contents", 10, 0.012],
      ["list_commits", 6, 0.003],
      ["create_pull_request", 3, 0.031],
      ["create_issue_comment", 2.5, 0.006],
    ],
  },
  {
    name: "atlassian-jira",
    reach: 0.3,
    tools: [
      ["search_issues", 9, 0.014],
      ["get_issue", 7, 0.005],
      ["create_issue", 2.2, 0.022],
      ["transition_issue", 1.6, 0.048],
    ],
  },
  {
    name: "slack",
    reach: 0.35,
    tools: [
      ["search_messages", 7, 0.009],
      ["get_channel_history", 5, 0.006],
      ["post_message", 4, 0.011],
    ],
  },
  {
    name: "postgres-analytics",
    reach: 0.18,
    tools: [
      ["query", 12, 0.064],
      ["describe_table", 3, 0.004],
      ["list_tables", 2, 0.002],
    ],
  },
  {
    name: "archestra",
    reach: 0.5,
    tools: [
      ["archestra__search_tools", 6, 0.002],
      ["archestra__run_tool", 5, 0.017],
      ["archestra__list_apps", 2, 0.001],
      ["archestra__get_agent", 1.5, 0.001],
    ],
  },
  {
    name: "playwright",
    reach: 0.14,
    tools: [
      ["browser_navigate", 4, 0.052],
      ["browser_snapshot", 4, 0.021],
      ["browser_click", 3, 0.087],
      ["browser_take_screenshot", 1.2, 0.015],
    ],
  },
  {
    name: "kubernetes",
    reach: 0.12,
    tools: [
      ["get_pods", 3.5, 0.018],
      ["get_logs", 3, 0.035],
      ["describe_resource", 1.4, 0.026],
    ],
  },
  {
    name: "google-drive",
    reach: 0.3,
    tools: [
      ["search_files", 3.5, 0.007],
      ["read_file", 3, 0.015],
    ],
  },
  {
    name: "context7",
    reach: 0.22,
    tools: [
      ["resolve-library-id", 2.2, 0.004],
      ["get-library-docs", 2.2, 0.009],
    ],
  },
  {
    name: "linear",
    reach: 0.15,
    tools: [
      ["list_issues", 1.8, 0.005],
      ["update_issue", 0.9, 0.019],
    ],
  },
  {
    name: "notion",
    reach: 0.2,
    tools: [
      ["search", 1.4, 0.006],
      ["fetch_page", 1.1, 0.012],
    ],
  },
  {
    name: "filesystem",
    reach: 0.08,
    tools: [
      ["read_text_file", 1, 0.003],
      ["list_directory", 0.6, 0.002],
      ["write_file", 0.3, 0.041],
    ],
  },
];

const TOOLS: ToolSpec[] = MCP_SERVERS.flatMap((server) =>
  server.tools.map(([name, weight, errorRate]) => ({
    server: server.name,
    name,
    weight,
    errorRate,
  })),
);
