import {
  supportsUsage,
  USAGE_GROUPS,
  USAGE_METRICS,
  type UsageGroup,
  type UsageMetric,
} from "../../usage/usage-explorer-data";
import {
  type ChartKind,
  DIM_IDS,
  type DimId,
  METRIC_IDS,
  type MetricId,
  normalize,
  type PivotQuery,
  type SplitId,
} from "./cost-explorer-data";

export const EXPLORER_URL_KEYS = [
  "metric",
  "group",
  "split",
  "chart",
  "mobileChart",
  "view",
  "columns",
  "model",
  "labelKey",
  "focus",
] as const;
type CommonState = {
  chart: ChartKind;
  mobileChart?: ChartKind;
  view: "summary" | "pivot";
  model?: string;
  focus: Set<string>;
};
export type CostExplorerState = {
  query: PivotQuery;
  mobileChart?: ChartKind;
  focus: Set<string>;
  view: "summary" | "pivot";
  pivotCols: "days" | "split";
};
export type PersonalExplorerState = CommonState & {
  metric: UsageMetric;
  group: UsageGroup;
  split: boolean;
};
const choice = <T extends string>(
  raw: string | null,
  values: readonly T[],
  fallback: T,
): T => (values.includes(raw as T) ? (raw as T) : fallback);
const modelFor = (params: URLSearchParams) => {
  const model = params.get("model");
  return model && model.length <= 1024 ? model : undefined;
};
const mobileChartFor = (params: URLSearchParams): ChartKind | undefined => {
  const value = params.get("mobileChart");
  return value === "bars" || value === "lines" || value === "table"
    ? value
    : undefined;
};
const focusFor = (params: URLSearchParams) =>
  new Set(params.getAll("focus").filter(Boolean).slice(0, 100));

export function decodeCostExplorer(params: URLSearchParams): CostExplorerState {
  const model = modelFor(params);
  const metric = choice<MetricId>(params.get("metric"), METRIC_IDS, "billed");
  const group = choice<DimId>(params.get("group"), DIM_IDS, "model");
  const query = normalize({
    metric:
      model &&
      ![
        "billed",
        "subscription",
        "requests",
        "tokens",
        "cacheRead",
        "cacheWrite",
      ].includes(metric)
        ? "billed"
        : metric,
    group:
      model && !["person", "key", "agent"].includes(group) ? "person" : group,
    split: model
      ? "none"
      : choice<SplitId>(params.get("split"), ["none", ...DIM_IDS], "none"),
    chart: choice<ChartKind>(
      params.get("chart"),
      ["bars", "lines", "table"],
      "bars",
    ),
    model,
    labelKey: params.get("labelKey") || undefined,
  });
  return {
    query,
    mobileChart: mobileChartFor(params),
    focus: focusFor(params),
    view: choice(params.get("view"), ["summary", "pivot"], "summary"),
    pivotCols: choice(params.get("columns"), ["days", "split"], "days"),
  };
}
export function encodeCostExplorer(state: CostExplorerState) {
  const params = new URLSearchParams({
    metric: state.query.metric,
    group: state.query.group,
    split: state.query.split,
    chart: state.query.chart,
    view: state.view,
    columns: state.pivotCols,
  });
  if (state.mobileChart) params.set("mobileChart", state.mobileChart);
  if (state.query.model) params.set("model", state.query.model);
  if (state.query.group === "label" && state.query.labelKey)
    params.set("labelKey", state.query.labelKey);
  for (const key of [...state.focus].sort()) params.append("focus", key);
  return params;
}
export function decodePersonalExplorer(
  params: URLSearchParams,
): PersonalExplorerState {
  const model = modelFor(params);
  let metric = choice<UsageMetric>(
    params.get("metric"),
    USAGE_METRICS.map((row) => row.id),
    "billed",
  );
  let group = choice<UsageGroup>(
    params.get("group"),
    USAGE_GROUPS.map((row) => row.id),
    "model",
  );
  let chart = choice<ChartKind>(
    params.get("chart"),
    ["bars", "lines", "table"],
    "bars",
  );
  if (model) {
    if (metric === "cacheSavings") metric = "billed";
    if (group !== "client" && group !== "time") group = "client";
  }
  if (metric === "cacheSavings") {
    group = "overall";
    if (!params.has("chart")) chart = "table";
  }
  if (chart === "lines" && !params.has("group")) group = "time";
  if (!supportsUsage(group, metric)) group = "model";
  return {
    model,
    metric,
    group,
    chart,
    mobileChart: mobileChartFor(params),
    split:
      !model &&
      metric === "tokens" &&
      ["model", "client"].includes(group) &&
      params.get("split") === "token",
    view: choice(params.get("view"), ["summary", "pivot"], "summary"),
    focus: focusFor(params),
  };
}
export function encodePersonalExplorer(state: PersonalExplorerState) {
  const params = new URLSearchParams({
    metric: state.metric,
    group: state.group,
    split: state.split ? "token" : "none",
    chart: state.chart,
    view: state.view,
  });
  if (state.mobileChart) params.set("mobileChart", state.mobileChart);
  if (state.model) params.set("model", state.model);
  for (const key of [...state.focus].sort()) params.append("focus", key);
  return params;
}

export const EXPLORER_TABLE_URL_KEYS = [
  "sort",
  "direction",
  "rows",
  "expanded",
] as const;
export type ExplorerSortKey = "label" | "total" | "peak" | `x:${string}`;
export function decodeExplorerTable(params: URLSearchParams) {
  const raw = params.get("sort") ?? "total";
  const key: ExplorerSortKey =
    raw === "label" || raw === "total" || raw === "peak" || raw.startsWith("x:")
      ? (raw as ExplorerSortKey)
      : "total";
  return {
    sort: {
      key,
      dir: params.get("direction") === "asc" ? (1 as const) : (-1 as const),
    },
    open: new Set(params.getAll("expanded").slice(0, 100)),
    showAll: params.get("rows") === "all",
  };
}
export function encodeExplorerTable(
  state: ReturnType<typeof decodeExplorerTable>,
) {
  const params = new URLSearchParams({
    sort: state.sort.key,
    direction: state.sort.dir === 1 ? "asc" : "desc",
    rows: state.showAll ? "all" : "15",
  });
  for (const id of [...state.open].sort()) params.append("expanded", id);
  return params;
}
