"use client";
// Query model for the cost explorer: which metric × dimension
// combinations the API can answer, and a hook that turns whichever endpoint
// answers into one normalized cube (rows × time buckets, optional split).

import {
  archestraApiSdk,
  type archestraApiTypes,
  type StatisticsTimeFrame,
  type SupportedProvider,
} from "@archestra/shared";
import { useQueries } from "@tanstack/react-query";
import { useMemo } from "react";
import { useModelProviderCatalog } from "@/lib/integration-overrides";
import { useProxyLabelCosts } from "@/lib/proxy-label-costs.query";
import {
  useProfileStatistics,
  useProxyCostStatistics,
  useTeamStatistics,
} from "@/lib/statistics.query";
import { throwOnApiError } from "@/lib/utils/api";
import {
  type AppUsageDimension,
  formatCompact,
  formatCost,
  formatInt,
  type SkillUsageDimension,
  type ToolCallUsageDimension,
  useAppCostAttribution,
  useAppUsage,
  useCostStatistics,
  useSkillCostAttribution,
  useSkillUsage,
  useToolCallUsage,
  useUserUsageWithSeries,
} from "./cost-explorer.query";

// ===== query model =====
export const METRIC_IDS = [
  "billed",
  "subscription",
  "requests",
  "tokens",
  "toolCalls",
  "appRuns",
  "skillActivations",
] as const;
export type MetricId = (typeof METRIC_IDS)[number];

export const DIM_IDS = [
  "team",
  "agent",
  "model",
  "person",
  "app",
  "skill",
  "server",
  "tool",
  "method",
  "key",
  "providerKey",
  "pool",
  "label",
] as const;
export type DimId = (typeof DIM_IDS)[number];
export type SplitId = DimId | "none";
export type ChartKind = "bars" | "lines" | "table";

export type PivotQuery = {
  metric: MetricId;
  group: DimId;
  split: SplitId;
  chart: ChartKind;
  labelKey?: string;
};

export const METRICS: Record<
  MetricId,
  { label: string; money: boolean; note: string; caution?: boolean }
> = {
  billed: {
    label: "Billed spend",
    money: true,
    note: "Usage charges recorded for metered API keys. Subscription fees are not included.",
  },
  subscription: {
    label: "Subscription estimate",
    money: true,
    note: "Subscription usage valued at equivalent API token rates. This is an estimate, not your subscription bill; subscription fees are excluded.",
    caution: true,
  },
  requests: {
    label: "Requests",
    money: false,
    note: "LLM requests through the proxy.",
  },
  tokens: {
    label: "Tokens",
    money: false,
    note: "Counts newly processed input and output. Reused cached input is shown separately and is not included. Requests in flight may not appear yet.",
  },
  toolCalls: {
    label: "Tool calls",
    money: false,
    note: "MCP tool calls through the gateway.",
  },
  appRuns: {
    label: "App runs",
    money: false,
    note: "App opens recorded when a client lists its tools; not completed inference runs.",
  },
  skillActivations: {
    label: "Skill activations",
    money: false,
    note: "Times a skill was loaded into a conversation.",
  },
};

export const DIMS: Record<DimId, { label: string; plural: string }> = {
  team: { label: "Team", plural: "teams" },
  agent: { label: "Agent", plural: "agents" },
  model: { label: "Model", plural: "models" },
  person: { label: "Person", plural: "people" },
  app: { label: "App", plural: "apps" },
  skill: { label: "Skill", plural: "skills" },
  server: { label: "MCP server", plural: "servers" },
  tool: { label: "Tool", plural: "tools" },
  method: { label: "Access method", plural: "access methods" },
  key: { label: "Key", plural: "keys" },
  providerKey: { label: "Provider key", plural: "provider keys" },
  pool: { label: "Model pool", plural: "model pools" },
  label: { label: "Label", plural: "label values" },
};

const LLM_METRICS: MetricId[] = [
  "billed",
  "subscription",
  "requests",
  "tokens",
];

const SUPPORT: Record<DimId, MetricId[]> = {
  team: LLM_METRICS,
  agent: [...LLM_METRICS, "toolCalls"],
  model: LLM_METRICS,
  person: [...METRIC_IDS],
  app: ["billed", "requests", "tokens", "toolCalls", "appRuns"],
  skill: ["tokens", "skillActivations"],
  server: ["toolCalls"],
  tool: ["toolCalls"],
  method: LLM_METRICS,
  key: LLM_METRICS,
  providerKey: LLM_METRICS,
  pool: LLM_METRICS,
  label: LLM_METRICS,
};

export const supports = (group: DimId, metric: MetricId) =>
  SUPPORT[group].includes(metric);

export function splitOptions(metric: MetricId, group: DimId): DimId[] {
  if (metric === "toolCalls" && group !== "app") {
    const all: DimId[] = ["server", "tool", "person", "agent"];
    return all.filter(
      (d) => d !== group && !(group === "tool" && d === "server"),
    );
  }
  if (group === "app") return ["person"];
  if (group === "skill") return ["person"];
  if (group === "person") {
    if (metric === "appRuns") return ["app"];
    if (metric === "skillActivations") return ["skill"];
    return ["model"];
  }
  return [];
}

/** Keep a query valid after one chip changes. */
export function normalize(q: PivotQuery): PivotQuery {
  const group = supports(q.group, q.metric)
    ? q.group
    : (PREFERRED_GROUP[q.metric] ??
      DIM_IDS.find((d) => supports(d, q.metric)) ??
      "person");
  const split =
    q.split !== "none" && splitOptions(q.metric, group).includes(q.split)
      ? q.split
      : "none";
  return { ...q, group, split };
}

const PREFERRED_GROUP: Partial<Record<MetricId, DimId>> = {
  toolCalls: "server",
  appRuns: "app",
  skillActivations: "skill",
};

export const SAVED_VIEWS: { id: string; label: string; q: PivotQuery }[] = [
  {
    id: "spend-model",
    label: "Spend by model",
    q: { metric: "billed", group: "model", split: "none", chart: "bars" },
  },
  {
    id: "spend-label",
    label: "Spend by label",
    q: {
      metric: "billed",
      group: "label",
      split: "none",
      chart: "bars",
      labelKey: "cost_center",
    },
  },
  {
    id: "who",
    label: "Who is using it",
    q: { metric: "tokens", group: "person", split: "none", chart: "lines" },
  },
  {
    id: "apps",
    label: "Apps by runs",
    q: { metric: "appRuns", group: "app", split: "none", chart: "bars" },
  },
  {
    id: "tools",
    label: "Tool calls by server",
    q: { metric: "toolCalls", group: "server", split: "tool", chart: "bars" },
  },
  {
    id: "keys",
    label: "Keys by spend",
    q: { metric: "billed", group: "key", split: "none", chart: "table" },
  },
  {
    id: "provider-keys",
    label: "Provider keys by spend",
    q: {
      metric: "billed",
      group: "providerKey",
      split: "none",
      chart: "table",
    },
  },
  {
    id: "skills",
    label: "Skills by reach",
    q: {
      metric: "skillActivations",
      group: "skill",
      split: "none",
      chart: "bars",
    },
  },
];

// ===== formatting =====
export function formatValue(metric: MetricId, v: number) {
  if (METRICS[metric].money) return formatCost(v);
  return v >= 100_000 ? formatCompact(v) : formatInt(v);
}

export function formatCell(metric: MetricId, v: number) {
  if (v === 0) return "·";
  if (METRICS[metric].money) {
    if (v >= 1000) return formatCost(v);
    return v >= 10 ? `$${Math.round(v)}` : `$${v.toFixed(2)}`;
  }
  return formatCompact(v);
}

export function bucketFormatter(buckets: string[]) {
  const parse = (b: string) =>
    new Date(b.length === 10 ? `${b}T00:00:00Z` : b).getTime();
  const step =
    buckets.length > 1 ? parse(buckets[1]) - parse(buckets[0]) : 86_400_000;
  const daily = step >= 86_400_000;
  const multipleDays = buckets.some(
    (bucket) =>
      new Date(parse(bucket)).toISOString().slice(0, 10) !==
      new Date(parse(buckets[0])).toISOString().slice(0, 10),
  );
  const fmt = new Intl.DateTimeFormat(
    "en-US",
    daily
      ? { month: "short", day: "numeric", timeZone: "UTC" }
      : {
          ...(multipleDays
            ? { month: "short" as const, day: "numeric" as const }
            : {}),
          hour: "2-digit",
          minute: "2-digit",
          timeZone: "UTC",
        },
  );
  return (b: string) => fmt.format(parse(b));
}

export const TIMEFRAME_LABEL: Record<string, string> = {
  "5m": "last 5 minutes",
  "15m": "last 15 minutes",
  "30m": "last 30 minutes",
  "1h": "last hour",
  "24h": "last 24 hours",
  "7d": "last 7 days",
  "30d": "last 30 days",
  "90d": "last 90 days",
  "12m": "last 12 months",
  all: "all time",
};

export const METHOD_NAMES: Record<string, string> = {
  virtual_key: "Virtual key",
  passthrough_virtual_key: "Passthrough key",
  oauth_client_credentials: "OAuth client credentials",
  oauth_user: "OAuth sign-in",
  jwks: "JWT / JWKS",
  provider_key: "Provider key",
  personal_token: "Personal token",
  internal: "Internal",
  unknown: "Unknown",
};

// ===== cube =====
export type ExtraCol = {
  id: string;
  label: string;
  format: (v: number) => string;
};

export type CubeChild = {
  key: string;
  label: string;
  total: number;
  series: number[];
};

export type CubeRow = {
  limitTarget?: { entityType: "virtual_key"; entityId: string };
  key: string;
  label: string;
  sub?: string;
  tag?: string;
  total: number;
  series: number[];
  hasSeries: boolean;
  extras: Record<string, number>;
  children: CubeChild[];
};

export type Cube = {
  buckets: string[];
  rows: CubeRow[];
  splitKeys: { key: string; label: string; total: number }[];
  extraCols: ExtraCol[];
  api: string;
  isLoading: boolean;
  error?: unknown;
  notice?: string;
  retry: () => void;
  total: number;
};

export function usePivotCube(
  q: PivotQuery,
  timeframe: StatisticsTimeFrame,
  enabled: boolean,
): Cube {
  const src = resolveSource(q);
  const on = (kind: Source["kind"]) => enabled && src.kind === kind;

  // Usage endpoints allow 100 rows per request; the usage hook collects pages.
  const toolArgs = {
    timeframe,
    groupBy: src.kind === "tool" ? src.dims : (["day"] as const).slice(),
    enabled: on("tool"),
    limit: 100,
  };
  const toolQ = useToolCallUsage(toolArgs);
  const appArgs = {
    timeframe,
    groupBy: src.kind === "app" ? src.dims : (["day"] as AppUsageDimension[]),
    enabled: on("app"),
    limit: 100,
  };
  const appCosts =
    src.kind === "app" &&
    q.group === "app" &&
    q.metric === "billed" &&
    q.split === "none";
  const appQ = useAppUsage({
    ...appArgs,
    enabled: appArgs.enabled && !appCosts,
  });
  const appCostQ = useAppCostAttribution({
    timeframe,
    enabled: enabled && appCosts,
  });
  const skillCostQ = useSkillCostAttribution({
    timeframe,
    enabled: on("skill") && q.group === "skill",
  });
  const skillArgs = {
    timeframe,
    groupBy:
      src.kind === "skill" ? src.dims : (["day"] as SkillUsageDimension[]),
    enabled: on("skill"),
    limit: 100,
  };
  const skillQ = useSkillUsage(skillArgs);
  const skillReachQ = useSkillUsage({
    timeframe,
    groupBy: ["skillId"],
    enabled: on("skill") && q.group === "skill",
  });
  const teamQ = useTeamStatistics({ timeframe, enabled: on("team") });
  const agentQ = useProfileStatistics({ timeframe, enabled: on("agent") });
  const modelQ = useCostStatistics({ timeframe, enabled: on("model") });
  const userQ = useUsersForPivot({
    timeframe,
    withModels: src.kind === "user" && src.models,
    sortBy:
      q.metric === "billed"
        ? "billedCost"
        : q.metric === "requests"
          ? "requests"
          : "totalTokens",
    enabled: on("user"),
  });
  const proxyQ = useProxyCostStatistics({
    timeframe,
    limit: 50,
    ...(q.group === "providerKey" ? { includeProviderKeys: "true" } : {}),
    ...(q.group === "pool" ? { includeModelPools: "true" } : {}),
    enabled: on("proxy") && q.group !== "label",
  });
  const providerCatalog = useModelProviderCatalog();
  const labelQ = useProxyLabelCosts({
    timeframe,
    labelKey: q.labelKey ?? "cost_center",
    enabled: on("proxy") && q.group === "label",
  });

  const proxyBy = src.kind === "proxy" ? src.by : null;
  const proxyItems = useMemo(() => {
    if (proxyBy === "label")
      return (labelQ.data?.groups ?? []).map(({ value, ...totals }) => ({
        key: value === null ? "missing" : `value:${value}`,
        label: value ?? "Unassigned (label missing)",
        sub: undefined as string | undefined,
        tag: value === null ? "Label missing" : undefined,
        totals,
        filter: {
          labelKey: q.labelKey ?? "cost_center",
          ...(value === null
            ? { labelUnassigned: "true" }
            : { labelValue: value }),
        } as ProxyFilter,
      }));
    return proxyBy && proxyQ.data
      ? proxyItemsFor(proxyBy, proxyQ.data, providerCatalog.label)
      : [];
  }, [proxyBy, proxyQ.data, labelQ.data, q.labelKey, providerCatalog]);
  const itemQs = useQueries({
    queries: proxyItems.map((item) => ({
      queryKey: ["cost-explorer", "proxy-item", timeframe, item.filter],
      queryFn: async () => {
        const { data, error } = await archestraApiSdk.getProxyCostStatistics({
          query: { timeframe, limit: 1, ...(item.filter ?? {}) },
        });
        throwOnApiError(error, { toastOnError: false });
        return data ?? null;
      },
      enabled: enabled && src.kind === "proxy" && item.filter !== null,
      staleTime: 60_000,
    })),
  });
  const itemStamp = itemQs.map((r) => r.dataUpdatedAt).join(",");

  const tf = String(timeframe);
  // biome-ignore lint/correctness/useExhaustiveDependencies: itemStamp tracks itemQs
  return useMemo(() => {
    const metric = q.metric;
    const primary =
      src.kind === "tool"
        ? toolQ
        : src.kind === "app"
          ? appCosts
            ? appCostQ
            : appQ
          : src.kind === "skill"
            ? skillQ
            : src.kind === "team"
              ? teamQ
              : src.kind === "agent"
                ? agentQ
                : src.kind === "model"
                  ? modelQ
                  : src.kind === "user"
                    ? userQ
                    : q.group === "label"
                      ? labelQ
                      : proxyQ;
    const failed = [
      primary,
      ...(src.kind === "proxy" ? itemQs : []),
      ...(src.kind === "skill" && q.group === "skill"
        ? [skillReachQ, skillCostQ]
        : []),
    ].find((query) => query.isError);
    const base = {
      api: apiFor(src, tf, q),
      isLoading: false,
      error: failed?.error,
      retry: () => {
        void primary.refetch();
        for (const query of itemQs) void query.refetch();
        if (src.kind === "skill") {
          void skillReachQ.refetch();
          void skillCostQ.refetch();
        }
      },
    };
    switch (src.kind) {
      case "tool": {
        const rows = toolQ.data?.data ?? [];
        const facts: Fact[] = rows.map((r) => {
          const g = toolDimValue(q.group, r);
          const s = q.split !== "none" ? toolDimValue(q.split, r) : null;
          return {
            ...g,

            s: s?.g,
            sLabel: s?.gLabel,
            b: r.day ?? "",
            v: r.calls,
            extra: { errors: r.errors },
          };
        });
        const cube = assemble(facts);
        for (const row of cube.rows) {
          row.extras.errorRate = row.total
            ? (row.extras.errors ?? 0) / row.total
            : 0;
        }
        return {
          ...cube,
          ...base,
          isLoading: toolQ.isLoading,
          extraCols: [
            { id: "errors", label: "Errors", format: formatInt },
            {
              id: "errorRate",
              label: "Error rate",
              format: (v: number) => `${(v * 100).toFixed(1)}%`,
            },
          ],
        };
      }
      case "app": {
        if (appCosts) {
          const rows = appCostQ.data?.data ?? [];
          const facts: Fact[] = rows.map((row) => ({
            g: row.appId,
            gLabel: row.appName,
            gSub: row.authorName ?? undefined,
            gTag: !row.hasBuildSession
              ? "No recorded build session"
              : row.buildSessionAppCount > 1
                ? `Shared build session · ${row.buildSessionAppCount} apps`
                : undefined,
            b: "",
            v: row.buildCost + row.runtimeCost,
            extra: {
              build: row.hasBuildSession ? row.buildCost : -1,
              runtime: row.runtimeCost,
              chat: row.estimatedChatEquivalentCost,
              savings: row.estimatedNetSavings,
            },
          }));
          return {
            ...assemble(facts),
            ...base,
            api: `GET /api/statistics/apps?timeframe=${tf}`,
            isLoading: appCostQ.isLoading,
            notice: `Build cost belongs to the authoring session and may be shared by several apps. Runtime cost is the app's own inference. Chat-equivalent estimates use the measured average of ${formatCost(appCostQ.data?.chatBaselineCostPerSession ?? 0)} across ${appCostQ.data?.chatBaselineSessions ?? 0} chat sessions.`,
            extraCols: [
              {
                id: "build",
                label: "Build spend",
                format: (value) => (value < 0 ? "—" : formatCost(value)),
              },
              { id: "runtime", label: "Runtime spend", format: formatCost },
              {
                id: "chat",
                label: "Chat-equivalent estimate",
                format: formatCost,
              },
              {
                id: "savings",
                label: "Estimated net savings",
                format: formatCost,
              },
            ],
          };
        }
        const rows = appQ.data?.data ?? [];
        const pick = (r: (typeof rows)[number]) =>
          metric === "billed"
            ? r.billedCost
            : metric === "requests"
              ? r.llmRequests
              : metric === "tokens"
                ? r.totalTokens
                : metric === "toolCalls"
                  ? r.toolCalls
                  : r.runs;
        const facts: Fact[] = rows.map((r) => {
          const isApp = q.group === "app";
          return {
            g: (isApp ? r.appId : r.userId) ?? "?",
            gLabel: (isApp ? r.appName : r.userName) ?? "Unknown",
            s:
              q.split === "none"
                ? undefined
                : ((isApp ? r.userId : r.appId) ?? undefined),
            sLabel:
              q.split === "none"
                ? undefined
                : ((isApp ? r.userName : r.appName) ?? "Unknown"),
            b: r.day ?? "",
            v: pick(r),
          };
        });
        return { ...assemble(facts), ...base, isLoading: appQ.isLoading };
      }
      case "skill": {
        const rows = skillQ.data?.data ?? [];
        const reach = new Map(
          (skillReachQ.data?.data ?? []).map((r) => [r.skillId, r.users]),
        );
        const facts: Fact[] = rows.map((r) => {
          const isSkill = q.group === "skill";
          return {
            g: (isSkill ? r.skillId : r.userId) ?? "?",
            gLabel: (isSkill ? r.skillName : r.userName) ?? "Unknown",
            s:
              q.split === "none"
                ? undefined
                : ((isSkill ? r.userId : r.skillId) ?? undefined),
            sLabel:
              q.split === "none"
                ? undefined
                : ((isSkill ? r.userName : r.skillName) ?? "Unknown"),
            b: r.day ?? "",
            v: metric === "tokens" ? r.contextTokens : r.activations,
          };
        });
        const cube = assemble(facts);
        if (q.group === "skill") {
          const attribution = new Map(
            (skillCostQ.data?.data ?? []).map((row) => [row.skillId, row]),
          );
          for (const row of cube.rows) {
            row.extras.people = reach.get(row.key) ?? 0;
            const context = attribution.get(row.key);
            if (context) {
              row.extras.turnSpend = context.attributedCost;
              row.extras.turnRequests = context.attributedRequests;
              if (context.measuredActivations < context.activations)
                row.tag = `${context.measuredActivations} of ${context.activations} context measurements`;
            }
          }
        }
        return {
          ...cube,
          ...base,
          isLoading:
            skillQ.isLoading || (q.group === "skill" && skillCostQ.isLoading),
          notice:
            q.group === "skill"
              ? "Context tokens measure the skill's injected content. Attributed turn spend covers entire turns and can overlap with other skills; it is not an exclusive skill cost. The attribution source is GET /api/statistics/skills."
              : undefined,
          extraCols:
            q.group === "skill"
              ? [
                  { id: "people", label: "People", format: formatInt },
                  {
                    id: "turnSpend",
                    label: "Attributed turn spend",
                    format: formatCost,
                  },
                  {
                    id: "turnRequests",
                    label: "Attributed requests",
                    format: formatInt,
                  },
                ]
              : [],
        };
      }
      case "team":
      case "agent":
      case "model": {
        const list =
          src.kind === "team"
            ? (teamQ.data ?? []).map((t) => ({
                key: t.teamId,
                label: t.teamName,
                sub: `${t.members} members`,
                series: t.timeSeries,
                totals: t,
              }))
            : src.kind === "agent"
              ? (agentQ.data ?? []).map((a) => ({
                  key: a.agentId,
                  label: a.agentName,
                  sub: a.teamName,
                  series: a.timeSeries,
                  totals: a,
                }))
              : (modelQ.data?.models ?? []).map((m) => ({
                  key: m.model,
                  label: m.model,
                  sub: undefined,
                  series: m.timeSeries,
                  totals: m,
                }));
        const facts: Fact[] = list.flatMap((item) =>
          item.series.map((p) => ({
            g: item.key,
            gLabel: item.label,
            gSub: item.sub,
            b: p.timestamp,
            v: pointValue(metric, p),
          })),
        );
        const totals = new Map(
          list.map((item) => [
            item.key,
            metric === "billed"
              ? item.totals.cost
              : metric === "subscription"
                ? item.series.reduce(
                    (total, point) => total + pointValue(metric, point),
                    0,
                  )
                : pointValue(metric, item.totals),
          ]),
        );
        const meta = new Map(
          list.map((item) => [
            item.key,
            { g: item.key, gLabel: item.label, gSub: item.sub },
          ]),
        );
        const loading =
          src.kind === "team"
            ? teamQ.isLoading
            : src.kind === "agent"
              ? agentQ.isLoading
              : modelQ.isLoading;
        return {
          ...assemble(facts, { totals, meta }),
          ...base,
          isLoading: loading,
        };
      }
      case "user": {
        const facts: Fact[] = (userQ.data?.data ?? []).flatMap((u) =>
          src.models
            ? (u.models ?? []).flatMap((m) =>
                (m.timeSeries?.length
                  ? m.timeSeries
                  : [{ ...m, timestamp: "" }]
                ).map((p) => ({
                  g: u.userId,
                  gLabel: u.userName,
                  gSub: u.userEmail,
                  gTag:
                    u.billedCost === 0 && u.subscriptionCost > 0
                      ? "Subscription usage"
                      : undefined,
                  s: m.model,
                  sLabel: m.model,
                  b: p.timestamp,
                  v: pointValue(metric, p),
                })),
              )
            : (u.timeSeries?.length
                ? u.timeSeries
                : [{ ...u, timestamp: "" }]
              ).map((p) => ({
                g: u.userId,
                gLabel: u.userName,
                gSub: u.userEmail,
                gTag:
                  u.billedCost === 0 && u.subscriptionCost > 0
                    ? "Subscription usage"
                    : undefined,
                b: p.timestamp,
                v: pointValue(metric, p),
              })),
        );
        return { ...assemble(facts), ...base, isLoading: userQ.isLoading };
      }
      case "proxy": {
        const facts: Fact[] = [];
        const totals = new Map<string, number>();
        const meta = new Map<string, Omit<Fact, "b" | "v">>();
        const failedOver = new Map<string, number>();
        proxyItems.forEach((item, i) => {
          totals.set(item.key, pointValue(metric, item.totals));
          failedOver.set(item.key, item.totals.failedOverAttempts);
          meta.set(item.key, {
            g: item.key,
            gLabel: item.label,
            gSub: item.sub,
            gTag: item.tag,
            limitTarget: "limitTarget" in item ? item.limitTarget : undefined,
          });
          const series = itemQs[i]?.data?.timeSeries ?? [];
          for (const p of series) {
            facts.push({
              g: item.key,
              gLabel: item.label,
              gSub: item.sub,
              gTag: item.tag,
              limitTarget: "limitTarget" in item ? item.limitTarget : undefined,
              b: p.timestamp,
              v: pointValue(metric, p),
            });
          }
        });
        const cube = assemble(facts, { totals, meta });
        // A pool that failed over wrote one request per attempt; show how
        // many of the requests were attempts the client never saw.
        const showFailedOver =
          metric === "requests" &&
          proxyItems.some((item) => item.totals.failedOverAttempts > 0);
        if (showFailedOver) {
          for (const row of cube.rows) {
            row.extras.failedOver = failedOver.get(row.key) ?? 0;
          }
        }
        return {
          ...cube,
          ...base,
          extraCols: showFailedOver
            ? [{ id: "failedOver", label: "Failed over", format: formatInt }]
            : [],
          isLoading:
            primary.isLoading || itemQs.some((query) => query.isLoading),
        };
      }
    }
  }, [
    q.metric,
    q.group,
    q.split,
    q.labelKey,
    labelQ.data,
    labelQ.error,
    labelQ.isLoading,
    tf,
    src.kind,
    toolQ.error,
    toolQ.data,
    toolQ.isLoading,
    appCosts,
    appCostQ.data,
    appCostQ.error,
    appCostQ.isLoading,
    skillCostQ.data,
    skillCostQ.error,
    skillCostQ.isLoading,
    appQ.error,
    appQ.data,
    appQ.isLoading,
    skillQ.error,
    skillQ.data,
    skillQ.isLoading,
    skillReachQ.error,
    skillReachQ.data,
    teamQ.error,
    teamQ.data,
    teamQ.isLoading,
    agentQ.error,
    agentQ.data,
    agentQ.isLoading,
    modelQ.error,
    modelQ.data,
    modelQ.isLoading,
    userQ.error,
    userQ.data,
    userQ.isLoading,
    proxyQ.error,
    proxyQ.data,
    proxyQ.isLoading,
    proxyItems,
    itemStamp,
  ]);
}

// ===== internals =====
type Source =
  | { kind: "tool"; dims: ToolCallUsageDimension[] }
  | { kind: "app"; dims: AppUsageDimension[] }
  | { kind: "skill"; dims: SkillUsageDimension[] }
  | { kind: "team" }
  | { kind: "agent" }
  | { kind: "model" }
  | { kind: "user"; models: boolean }
  | { kind: "proxy"; by: ProxyGroup };

function resolveSource(q: PivotQuery): Source {
  const split = q.split === "none" ? null : q.split;
  if (q.metric === "toolCalls" && q.group !== "app") {
    const dims = new Set<ToolCallUsageDimension>(["day"]);
    for (const d of [q.group, split]) {
      if (d === "server") dims.add("mcpServerName");
      if (d === "tool") {
        dims.add("mcpServerName");
        dims.add("toolName");
      }
      if (d === "person") dims.add("userId");
      if (d === "agent") dims.add("agentId");
    }
    return { kind: "tool", dims: [...dims] };
  }
  if (q.group === "app" || q.metric === "appRuns") {
    const dims: AppUsageDimension[] = ["day"];
    for (const d of [q.group, split]) {
      if (d === "app") dims.push("appId");
      if (d === "person") dims.push("userId");
    }
    return { kind: "app", dims };
  }
  if (q.group === "skill" || q.metric === "skillActivations") {
    const dims: SkillUsageDimension[] = ["day"];
    for (const d of [q.group, split]) {
      if (d === "skill") dims.push("skillId");
      if (d === "person") dims.push("userId");
    }
    return { kind: "skill", dims };
  }
  if (q.group === "team") return { kind: "team" };
  if (q.group === "agent") return { kind: "agent" };
  if (q.group === "model") return { kind: "model" };
  if (
    q.group === "method" ||
    q.group === "key" ||
    q.group === "providerKey" ||
    q.group === "pool" ||
    q.group === "label"
  )
    return { kind: "proxy", by: q.group };
  return { kind: "user", models: split === "model" };
}

function apiFor(src: Source, tf: string, q: PivotQuery) {
  switch (src.kind) {
    case "tool":
      return `GET /api/statistics/mcp-tool-calls?groupBy=${src.dims.join(",")}&timeframe=${tf}`;
    case "app":
      return `GET /api/statistics/app-usage?groupBy=${src.dims.join(",")}&timeframe=${tf}`;
    case "skill":
      return `GET /api/statistics/skill-usage?groupBy=${src.dims.join(",")}&timeframe=${tf}`;
    case "team":
      return `GET /api/statistics/teams?timeframe=${tf}`;
    case "agent":
      return `GET /api/statistics/agents?timeframe=${tf}`;
    case "model":
      return `GET /api/statistics/models?timeframe=${tf}`;
    case "user":
      return `GET /api/statistics/users?includeTimeSeries=true${src.models ? "&includeModels=true&includeModelTimeSeries=true" : ""}&timeframe=${tf}`;
    case "proxy":
      if (q.group === "label")
        return `GET /api/statistics/llm-proxy?timeframe=${tf}&labelKey=${encodeURIComponent(q.labelKey ?? "cost_center")}`;
      if (q.group === "providerKey")
        return `GET /api/statistics/llm-proxy?timeframe=${tf}&includeProviderKeys=true`;
      if (q.group === "pool")
        return `GET /api/statistics/llm-proxy?timeframe=${tf}&includeModelPools=true`;
      return `GET /api/statistics/llm-proxy?timeframe=${tf}${q.group === "key" ? "&credentialId={id}" : "&authMethod={method}"}`;
  }
}

type Fact = {
  limitTarget?: CubeRow["limitTarget"];
  g: string;
  gLabel: string;
  gSub?: string;
  gTag?: string;
  s?: string;
  sLabel?: string;
  b: string;
  v: number;
  extra?: Record<string, number>;
};

type SeriesPointLike = {
  totalTokens?: number;
  value?: number;
  requests?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  billedCost?: number;
  subscriptionCost?: number;
};

function pointValue(metric: MetricId, p: SeriesPointLike) {
  switch (metric) {
    case "billed":
      return p.billedCost ?? p.value ?? 0;
    case "subscription":
      return p.subscriptionCost ?? 0;
    case "requests":
      return p.requests ?? 0;
    case "tokens":
      return p.totalTokens ?? 0;
    default:
      return 0;
  }
}

function toolDimValue(
  dim: DimId | SplitId,
  r: {
    mcpServerName?: string;
    toolName?: string | null;
    userId?: string | null;
    userName?: string | null;
    agentId?: string | null;
    agentName?: string | null;
  },
): { g: string; gLabel: string; gSub?: string } {
  switch (dim) {
    case "server":
      return { g: r.mcpServerName ?? "?", gLabel: r.mcpServerName ?? "?" };
    case "tool":
      return {
        g: `${r.mcpServerName}/${r.toolName}`,
        gLabel: r.toolName ?? "?",
        gSub: r.mcpServerName,
      };
    case "person":
      return { g: r.userId ?? "?", gLabel: r.userName ?? "Unknown" };
    default:
      return { g: r.agentId ?? "?", gLabel: r.agentName ?? "Unknown" };
  }
}

function assemble(
  facts: Fact[],
  opts: {
    totals?: Map<string, number>;
    meta?: Map<string, Omit<Fact, "b" | "v">>;
  } = {},
): Omit<Cube, "api" | "isLoading" | "extraCols" | "error" | "retry"> & {
  extraCols: ExtraCol[];
} {
  const buckets = [...new Set(facts.map((f) => f.b).filter(Boolean))].sort();
  const idx = new Map(buckets.map((b, i) => [b, i]));
  type Acc = CubeRow & { childMap: Map<string, CubeChild> };
  const rows = new Map<string, Acc>();
  const splitTotals = new Map<
    string,
    { key: string; label: string; total: number }
  >();
  const ensure = (m: Omit<Fact, "b" | "v">) => {
    let row = rows.get(m.g);
    if (!row) {
      row = {
        key: m.g,
        label: m.gLabel,
        sub: m.gSub,
        tag: m.gTag,
        limitTarget: m.limitTarget,
        total: 0,
        series: buckets.map(() => 0),
        hasSeries: false,
        extras: {},
        children: [],
        childMap: new Map(),
      };
      rows.set(m.g, row);
    }
    return row;
  };
  for (const f of facts) {
    const row = ensure(f);
    const i = idx.get(f.b);
    if (i !== undefined) row.series[i] += f.v;
    row.total += f.v;
    row.hasSeries ||= i !== undefined;
    for (const [k, v] of Object.entries(f.extra ?? {}))
      row.extras[k] = (row.extras[k] ?? 0) + v;
    if (f.s !== undefined) {
      let child = row.childMap.get(f.s);
      if (!child) {
        child = {
          key: f.s,
          label: f.sLabel ?? f.s,
          total: 0,
          series: buckets.map(() => 0),
        };
        row.childMap.set(f.s, child);
      }
      if (i !== undefined) child.series[i] += f.v;
      child.total += f.v;
      const st = splitTotals.get(f.s) ?? {
        key: f.s,
        label: f.sLabel ?? f.s,
        total: 0,
      };
      st.total += f.v;
      splitTotals.set(f.s, st);
    }
  }
  for (const [, m] of opts.meta ?? new Map()) ensure(m);
  for (const [k, total] of opts.totals ?? new Map()) {
    const row = rows.get(k);
    if (row) row.total = total;
  }
  const out: CubeRow[] = [...rows.values()]
    .map(({ childMap, ...row }) => ({
      ...row,
      children: [...childMap.values()].sort((a, b) => b.total - a.total),
    }))
    .filter((r) => r.total > 0 || r.hasSeries || r.tag || opts.meta?.has(r.key))
    .sort((a, b) => b.total - a.total);
  return {
    buckets,
    rows: out,
    splitKeys: [...splitTotals.values()].sort((a, b) => b.total - a.total),
    extraCols: [],
    total: out.reduce((a, r) => a + r.total, 0),
  };
}

type ProxyData = archestraApiTypes.GetProxyCostStatisticsResponses["200"];
type ProxyGroup = "method" | "key" | "providerKey" | "pool" | "label";
type ProxyFilter =
  | { credentialId: string }
  | { providerApiKeyId: string }
  | { modelPoolId: string }
  | { authMethod: ProxyData["methods"][number]["authMethod"] }
  | { labelKey: string; labelValue: string }
  | { labelKey: string; labelUnassigned: "true" };

function proxyItemsFor(
  by: Exclude<ProxyGroup, "label">,
  data: ProxyData,
  providerLabel: (provider: SupportedProvider) => string,
) {
  if (by === "providerKey") {
    return (data.providerKeys ?? []).map((k) => ({
      key: k.providerApiKeyId ?? "none",
      label:
        k.providerApiKeyName ??
        (k.providerApiKeyId ? "Deleted provider key" : "No provider key"),
      sub: k.providerApiKeyId
        ? `ID ${k.providerApiKeyId}`
        : "The caller's own key, or a call from before keys were recorded",
      tag: k.provider
        ? providerLabel(k.provider as SupportedProvider)
        : undefined,
      totals: k,
      filter: k.providerApiKeyId
        ? ({ providerApiKeyId: k.providerApiKeyId } as ProxyFilter)
        : null,
    }));
  }
  if (by === "pool") {
    return (data.modelPools ?? []).map((p) => ({
      key: p.modelPoolId ?? "none",
      label: p.modelPoolName ?? (p.modelPoolId ? "Deleted pool" : "Not pooled"),
      sub: p.modelPoolId ? `ID ${p.modelPoolId}` : undefined,
      tag: undefined as string | undefined,
      totals: p,
      filter: p.modelPoolId
        ? ({ modelPoolId: p.modelPoolId } as ProxyFilter)
        : null,
    }));
  }
  if (by === "method") {
    return data.methods.map((m) => ({
      key: m.authMethod,
      label: METHOD_NAMES[m.authMethod] ?? m.authMethod,
      sub: undefined as string | undefined,
      tag: undefined as string | undefined,
      limitTarget: undefined as CubeRow["limitTarget"],
      totals: m,
      filter: { authMethod: m.authMethod } as ProxyFilter | null,
    }));
  }
  const perMethod = new Map<string, number>();
  for (const c of data.credentials)
    perMethod.set(c.authMethod, (perMethod.get(c.authMethod) ?? 0) + 1);
  return data.credentials.map((c, i) => {
    const method = METHOD_NAMES[c.authMethod] ?? c.authMethod;
    // A row without a credential id can only be trended when it is the
    // method's only row; otherwise its trend is unknowable.
    const filter: ProxyFilter | null = c.credentialId
      ? { credentialId: c.credentialId }
      : perMethod.get(c.authMethod) === 1
        ? { authMethod: c.authMethod }
        : null;
    return {
      key: c.credentialId ?? `${c.authMethod}#${i}`,
      limitTarget:
        c.credentialId &&
        (c.authMethod === "virtual_key" ||
          c.authMethod === "passthrough_virtual_key")
          ? { entityType: "virtual_key" as const, entityId: c.credentialId }
          : undefined,
      label: c.credentialName ?? method,
      sub: c.credentialId
        ? `ID ${c.credentialId}`
        : "No individual key identifier recorded",
      tag: method,
      totals: c,
      filter,
    };
  });
}

function useUsersForPivot({
  timeframe,
  withModels,
  sortBy,
  enabled,
}: {
  timeframe: StatisticsTimeFrame;
  withModels: boolean;
  sortBy: "billedCost" | "requests" | "totalTokens";
  enabled: boolean;
}) {
  return useUserUsageWithSeries({
    timeframe,
    includeModels: withModels,
    sortBy,
    enabled,
  });
}
