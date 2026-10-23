import type { Cube, CubeRow } from "../(costs)/costs/cost-explorer-data";
import type { UsageViewProps } from "./usage-data";

export type UsageMetric = "billed" | "subscription" | "requests" | "tokens";
export type UsageGroup =
  | "model"
  | "client"
  | "time"
  | "token"
  | "context"
  | "session";
export const USAGE_METRICS = [
  { id: "billed", label: "Billed spend" },
  { id: "subscription", label: "Subscription estimate" },
  { id: "requests", label: "Requests" },
  { id: "tokens", label: "Tokens" },
] satisfies { id: UsageMetric; label: string }[];
export const USAGE_GROUPS = [
  { id: "model", label: "Model" },
  { id: "client", label: "Client" },
  { id: "time", label: "Time" },
  { id: "token", label: "Token type" },
  { id: "context", label: "Context size" },
  { id: "session", label: "Session" },
] satisfies { id: UsageGroup; label: string }[];

export function supportsUsage(group: UsageGroup, metric: UsageMetric) {
  return group === "token"
    ? metric === "tokens"
    : group === "context"
      ? metric === "requests" || metric === "tokens"
      : true;
}

export function usageSeries(
  statistics: UsageViewProps["statistics"],
  metric: UsageMetric,
): number[] | undefined {
  const values = statistics.timeSeries.map((point) =>
    metric === "billed"
      ? (point.billedCost ?? point.value)
      : metric === "subscription"
        ? point.subscriptionCost
        : metric === "requests"
          ? point.requests
          : point.totalTokens,
  );
  return values.length > 0 &&
    values.every((value) => value !== undefined && Number.isFinite(value))
    ? (values as number[])
    : undefined;
}

export function usageCube(
  { statistics, breakdown, timeframe }: UsageViewProps,
  metric: UsageMetric,
  group: UsageGroup,
  split: boolean,
): Cube {
  const field =
    metric === "billed"
      ? "billedCost"
      : metric === "subscription"
        ? "subscriptionCost"
        : metric === "tokens"
          ? "totalTokens"
          : "requests";
  const format = (n: number) => n.toLocaleString();
  const money = (n: number) => `$${n.toFixed(2)}`;
  const base = (key: string, label: string, total: number): CubeRow => ({
    key,
    label,
    total,
    series: [],
    hasSeries: false,
    extras: {},
    children: [],
  });
  let rows: CubeRow[] = [];
  let notice =
    "Personal activity only. Token totals include reported input, output, cache reads and cache writes.";
  let extraCols: Cube["extraCols"] = [];
  const buckets =
    group === "time" ? statistics.timeSeries.map((p) => p.timestamp) : [];
  if (group === "model" || group === "client") {
    const source =
      group === "model"
        ? statistics.models.map((m) => ({ ...m, key: m.model, label: m.model }))
        : breakdown.clients.map((c) => ({
            ...c,
            key: c.client ?? "__unreported__",
            label: c.client ?? "Not reported",
          }));
    rows = source.map((item) => ({
      ...base(item.key, item.label, item[field]),
      extras: {
        requests: item.requests,
        input: Math.max(
          0,
          item.totalTokens -
            item.outputTokens -
            item.cacheReadTokens -
            item.cacheWriteTokens,
        ),
        output: item.outputTokens,
        cache: item.cacheReadTokens,
        cacheWrite: item.cacheWriteTokens,
        billed: item.billedCost,
        subscription: item.subscriptionCost,
      },
      children: split
        ? [
            {
              key: "input",
              label: "Input",
              total: Math.max(
                0,
                item.totalTokens -
                  item.outputTokens -
                  item.cacheReadTokens -
                  item.cacheWriteTokens,
              ),
              series: [],
            },
            {
              key: "output",
              label: "Output",
              total: item.outputTokens,
              series: [],
            },
            {
              key: "cacheRead",
              label: "Cache reads",
              total: item.cacheReadTokens,
              series: [],
            },
            {
              key: "cacheWrite",
              label: "Cache writes",
              total: item.cacheWriteTokens,
              series: [],
            },
          ]
        : [],
    }));
    extraCols = [
      { id: "requests", label: "Requests", format },
      { id: "input", label: "Input", format },
      { id: "output", label: "Output", format },
      { id: "cache", label: "Cache reads", format },
      { id: "cacheWrite", label: "Cache writes", format },
      { id: "billed", label: "Billed spend", format: money },
      { id: "subscription", label: "Subscription estimate", format: money },
    ].filter((c) => c.id !== metric);
  } else if (group === "time") {
    const series = usageSeries(statistics, metric);
    const complete = series !== undefined;
    rows = [
      {
        ...base("personal", "Your usage", statistics[field]),
        series: series ?? [],
        hasSeries: complete,
      },
    ];
    if (!complete)
      notice =
        "This response does not include a timeline for the selected metric. Its total is available in Summary.";
  } else if (group === "token") {
    rows = (
      [
        ["freshInputTokens", "Fresh input"],
        ["outputTokens", "Output"],
        ["cacheReadTokens", "Cache reads"],
        ["cacheWriteTokens", "Cache writes"],
      ] as const
    ).map(([key, label]) => base(key, label, breakdown.tokenMix[key]));
    notice =
      "Recorded token mix includes cache reads and writes. Cache savings are an estimate against full input pricing, not a bill credit.";
  } else if (group === "context") {
    const labels = {
      under32k: "Under 32K",
      under128k: "32K–128K",
      under256k: "128K–256K",
      over256k: "256K+",
    };
    rows = breakdown.contextBuckets.map((b) => ({
      ...base(
        b.bucket,
        labels[b.bucket],
        metric === "requests" ? b.requests : b.tokens,
      ),
      extras: { cost: b.cost },
    }));
    extraCols = [{ id: "cost", label: "List-price value", format: money }];
    notice =
      "Context bands include cached input. List-price value includes subscription-covered usage; it is not an additional bill.";
  } else {
    rows = breakdown.topSessions.map((s) => ({
      ...base(
        s.sessionId,
        s.sessionId,
        metric === "billed"
          ? s.billedCost
          : metric === "subscription"
            ? Math.max(0, s.cost - s.billedCost)
            : metric === "tokens"
              ? s.tokens
              : s.requests,
      ),
      sub: [s.model, s.client].filter(Boolean).join(" · "),
      extras: { duration: s.durationMinutes, cost: s.cost },
    }));
    extraCols = [
      { id: "duration", label: "Elapsed minutes", format },
      { id: "cost", label: "List-price value", format: money },
    ];
    notice = `Costliest ${rows.length} sessions only, not all usage. Duration is elapsed time between first and last request. ${breakdown.unsessionedRequests.toLocaleString()} requests have no session ID.`;
  }
  rows.sort((a, b) => b.total - a.total);
  return {
    buckets,
    rows,
    extraCols,
    splitKeys: split
      ? [
          {
            key: "input",
            label: "Input",
            total: rows.reduce((n, r) => n + (r.children[0]?.total ?? 0), 0),
          },
          {
            key: "output",
            label: "Output",
            total: rows.reduce((n, r) => n + (r.children[1]?.total ?? 0), 0),
          },
          {
            key: "cacheRead",
            label: "Cache reads",
            total: rows.reduce((n, r) => n + (r.children[2]?.total ?? 0), 0),
          },
          {
            key: "cacheWrite",
            label: "Cache writes",
            total: rows.reduce((n, r) => n + (r.children[3]?.total ?? 0), 0),
          },
        ]
      : [],
    total: rows.reduce((n, r) => n + r.total, 0),
    api: `GET /api/statistics/me${group === "client" || group === "token" || group === "context" || group === "session" ? "/breakdown" : ""}?timeframe=${timeframe}`,
    isLoading: false,
    retry: () => {},
    notice,
  };
}
