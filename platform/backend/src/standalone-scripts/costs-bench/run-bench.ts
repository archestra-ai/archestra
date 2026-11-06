// Binds the ports of the layers below before any other module loads.
import "@/server/composition";
import fs from "node:fs";
import path from "node:path";
import type { StatisticsTimeFrame } from "@archestra/shared";
import pg from "pg";
import { initializeDatabase } from "@/database";
import { LimitModel, StatisticsModel, UsageStatisticsModel } from "@/models";
import LlmThroughputModel from "@/models/llm-throughput";
import { assertPortsBound } from "@/models/ports";
import { listUserLimitUsage } from "@/services/user-limit-usage";

/**
 * Time every statistics read behind the Costs, Limits and My Usage pages
 * against a database seeded by seed.sql, at several timeframes.
 *
 *   ARCHESTRA_DATABASE_URL=postgresql://…/costs_bench pnpm bench:costs
 *
 * Refuses any database whose name does not start with costs_bench. Prints a
 * Markdown table; `--out <dir>` also writes the timings and the SQL each read
 * ran (for replaying against another database) as JSON.
 */

assertPortsBound();

const ORG = "bench-org";
const HEAVY_USER = "bench-user-1";
const TIMEFRAMES = (process.env.BENCH_TIMEFRAMES?.split(",") ?? [
  "7d",
  "30d",
  "90d",
  "12m",
]) as StatisticsTimeFrame[];
const RUNS = Number(process.env.BENCH_RUNS ?? 2);
const page = { limit: 100, offset: 0 };

type Read = { label: string; run: (timeframe: StatisticsTimeFrame) => unknown };

const READS: Read[] = [
  // Costs: KPI tiles, the time and model views.
  {
    label: "costs (KPIs, model, time)",
    run: (timeframe) =>
      StatisticsModel.getCostStatistics({
        timeframe,
        organizationId: ORG,
        requestingUserId: HEAVY_USER,
        canReadAllUsers: true,
      }),
  },
  {
    label: "teams",
    run: (timeframe) =>
      StatisticsModel.getTeamStatistics({ timeframe, organizationId: ORG }),
  },
  {
    label: "agents",
    run: (timeframe) =>
      StatisticsModel.getAgentStatistics({ timeframe, organizationId: ORG }),
  },
  {
    label: "models",
    run: (timeframe) =>
      StatisticsModel.getModelStatistics({ timeframe, organizationId: ORG }),
  },
  {
    label: "people (series)",
    run: (timeframe) =>
      StatisticsModel.getUserStatistics({
        timeframe,
        organizationId: ORG,
        pagination: page,
        sortBy: "billedCost",
        sortDirection: "desc",
        includeTimeSeries: true,
        includeModels: false,
        requestingUserId: HEAVY_USER,
        canReadAllUsers: true,
      }),
  },
  {
    label: "people by model",
    run: (timeframe) =>
      StatisticsModel.getUserStatistics({
        timeframe,
        organizationId: ORG,
        pagination: page,
        sortBy: "billedCost",
        sortDirection: "desc",
        includeTimeSeries: true,
        includeModels: true,
        includeModelTimeSeries: true,
        requestingUserId: HEAVY_USER,
        canReadAllUsers: true,
      }),
  },
  {
    label: "apps (cost)",
    run: (timeframe) =>
      StatisticsModel.getAppStatistics({
        timeframe,
        organizationId: ORG,
        pagination: page,
        sortBy: "totalCost",
        sortDirection: "desc",
      }),
  },
  {
    label: "app runs",
    run: (timeframe) =>
      UsageStatisticsModel.getAppUsage({
        timeframe,
        organizationId: ORG,
        pagination: page,
        groupBy: ["day", "appId"],
      }),
  },
  {
    label: "skills (cost)",
    run: (timeframe) =>
      StatisticsModel.getSkillStatistics({
        timeframe,
        organizationId: ORG,
        pagination: page,
        sortBy: "contextTokens",
        sortDirection: "desc",
      }),
  },
  {
    label: "skill activations",
    run: (timeframe) =>
      UsageStatisticsModel.getSkillUsage({
        timeframe,
        organizationId: ORG,
        pagination: page,
        groupBy: ["day", "skillId"],
      }),
  },
  {
    label: "tool calls by server",
    run: (timeframe) =>
      UsageStatisticsModel.getMcpToolCallUsage({
        timeframe,
        organizationId: ORG,
        pagination: page,
        groupBy: ["day", "mcpServerName"],
      }),
  },
  {
    label: "tool calls by tool",
    run: (timeframe) =>
      UsageStatisticsModel.getMcpToolCallUsage({
        timeframe,
        organizationId: ORG,
        pagination: page,
        groupBy: ["day", "mcpServerName", "toolName"],
      }),
  },
  {
    label: "proxy by method",
    run: (timeframe) =>
      StatisticsModel.getProxyCostStatistics({
        timeframe,
        organizationId: ORG,
        limit: 50,
        offset: 0,
        includeGroupTimeSeries: true,
      }),
  },
  {
    label: "proxy by provider key",
    run: (timeframe) =>
      StatisticsModel.getProxyCostStatistics({
        timeframe,
        organizationId: ORG,
        limit: 50,
        offset: 0,
        includeProviderKeys: true,
        includeGroupTimeSeries: true,
      }),
  },
  {
    label: "proxy by label",
    run: (timeframe) =>
      StatisticsModel.getProxyCostStatistics({
        timeframe,
        organizationId: ORG,
        limit: 100,
        offset: 0,
        labelKey: "env",
        includeGroupTimeSeries: true,
      }),
  },
  {
    label: "label keys",
    run: (timeframe) =>
      StatisticsModel.getProxyCostStatistics({
        timeframe,
        organizationId: ORG,
        limit: 1,
        offset: 0,
        includeLabelKeys: true,
      }),
  },
  {
    label: "team x model (llm-usage)",
    run: (timeframe) =>
      UsageStatisticsModel.getLlmUsage({
        timeframe,
        organizationId: ORG,
        pagination: page,
        groupBy: ["day", "teamId", "model"],
      }),
  },
  {
    label: "provider (llm-usage)",
    run: (timeframe) =>
      UsageStatisticsModel.getLlmUsage({
        timeframe,
        organizationId: ORG,
        pagination: page,
        groupBy: ["day", "provider"],
      }),
  },
  {
    label: "key x model (llm-usage)",
    run: (timeframe) =>
      UsageStatisticsModel.getLlmUsage({
        timeframe,
        organizationId: ORG,
        pagination: page,
        groupBy: ["day", "credentialId", "model"],
      }),
  },
  {
    label: "model drill-down by person",
    run: (timeframe) =>
      StatisticsModel.getModelUsage({
        model: "bench-model-0",
        groupBy: "person",
        timeframe,
        organizationId: ORG,
        limit: 100,
        offset: 0,
      }),
  },
  {
    label: "model drill-down by key",
    run: (timeframe) =>
      StatisticsModel.getModelUsage({
        model: "bench-model-0",
        groupBy: "key",
        timeframe,
        organizationId: ORG,
        limit: 100,
        offset: 0,
      }),
  },
  // My Usage, for the heaviest user.
  {
    label: "my usage",
    run: (timeframe) =>
      StatisticsModel.getMyStatistics({
        timeframe,
        userId: HEAVY_USER,
        organizationId: ORG,
      }),
  },
  {
    label: "my usage breakdown",
    run: (timeframe) =>
      StatisticsModel.getMyUsageBreakdown({
        timeframe,
        userId: HEAVY_USER,
        organizationId: ORG,
        sessionLimit: 8,
      }),
  },
  {
    label: "my model drill-down",
    run: (timeframe) =>
      StatisticsModel.getModelUsage({
        model: "bench-model-0",
        groupBy: "client",
        timeframe,
        organizationId: ORG,
        userId: HEAVY_USER,
        limit: 100,
        offset: 0,
      }),
  },
];

// Limits read the current window, not a timeframe.
const LIMIT_READS: Read[] = [
  {
    label: "limits list (with spend)",
    run: async () => {
      const limits = await LimitModel.findAll(
        undefined,
        undefined,
        undefined,
        ORG,
      );
      await Promise.all([
        LimitModel.getSpendUsage(limits.map((limit) => limit.id)),
        LlmThroughputModel.usage(limits),
      ]);
    },
  },
  {
    label: "user limit usage (top 20)",
    run: () =>
      listUserLimitUsage({
        organizationId: ORG,
        query: { limit: 20, offset: 0 },
      }),
  },
];

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

async function main() {
  const outIndex = process.argv.indexOf("--out");
  const outDir = outIndex > 0 ? process.argv[outIndex + 1] : undefined;
  const only = process.env.BENCH_ONLY?.split(",");
  await initializeDatabase();
  await assertScratchDatabase();
  const captured = captureQueries();

  const results: Record<string, Record<string, number[] | string>> = {};
  const sqlByLabel: Record<
    string,
    Record<string, { text: string; values: unknown[] }[]>
  > = {};
  for (const read of [...READS, ...LIMIT_READS]) {
    if (only && !only.includes(read.label)) continue;
    const timeframes = LIMIT_READS.includes(read)
      ? (["current"] as const)
      : TIMEFRAMES;
    results[read.label] = {};
    sqlByLabel[read.label] = {};
    for (const timeframe of timeframes) {
      const times: number[] = [];
      try {
        for (let run = 0; run < RUNS; run++) {
          captured.length = 0;
          const start = performance.now();
          await read.run(timeframe as StatisticsTimeFrame);
          times.push(Math.round(performance.now() - start));
          sqlByLabel[read.label][timeframe] = [...captured];
        }
        results[read.label][timeframe] = times;
      } catch (error) {
        results[read.label][timeframe] = describeFailure(error);
      }
      console.error(
        `${read.label} ${timeframe}: ${results[read.label][timeframe]}`,
      );
    }
  }

  process.stdout.write(`${renderTable(results)}\n`);
  if (outDir) {
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(
      path.join(outDir, "timings.json"),
      JSON.stringify(results, null, 2),
    );
    fs.writeFileSync(
      path.join(outDir, "queries.json"),
      JSON.stringify(sqlByLabel, null, 2),
    );
  }
  process.exit(0);
}

async function assertScratchDatabase() {
  const client = new pg.Client({
    connectionString: process.env.ARCHESTRA_DATABASE_URL,
  });
  await client.connect();
  const {
    rows: [row],
  } = await client.query<{ name: string }>("SELECT current_database() AS name");
  await client.end();
  if (!row.name.startsWith("costs_bench"))
    throw new Error(
      `Refusing to benchmark ${row.name}: not a costs_bench database`,
    );
}

/** Record every query the pool runs, so a read's SQL can be replayed. */
function captureQueries() {
  const captured: { text: string; values: unknown[] }[] = [];
  const original = pg.Client.prototype.query;
  pg.Client.prototype.query = function (
    this: pg.Client,
    ...args: Parameters<typeof original>
  ) {
    const [config, values] = args as unknown as [unknown, unknown];
    const text =
      typeof config === "string"
        ? config
        : (config as { text?: string } | undefined)?.text;
    const params = Array.isArray(values)
      ? values
      : ((config as { values?: unknown[] } | undefined)?.values ?? []);
    if (text) captured.push({ text, values: params });
    return original.apply(this, args);
  } as typeof original;
  return captured;
}

function renderTable(
  results: Record<string, Record<string, number[] | string>>,
) {
  const columns = [...TIMEFRAMES, "current"];
  const lines = [
    `| read | ${columns.join(" | ")} |`,
    `|---|${columns.map(() => "---").join("|")}|`,
  ];
  for (const [label, byTimeframe] of Object.entries(results)) {
    const cells = columns.map((timeframe) => {
      const value = byTimeframe[timeframe];
      if (value === undefined) return "";
      if (typeof value === "string") return value;
      return `${Math.min(...value)} ms`;
    });
    lines.push(`| ${label} | ${cells.join(" | ")} |`);
  }
  return lines.join("\n");
}

/** A failed read's innermost cause, e.g. the pool's statement timeout. */
function describeFailure(error: unknown): string {
  let cause = error;
  while (cause instanceof Error && cause.cause !== undefined)
    cause = cause.cause;
  const message = cause instanceof Error ? cause.message : String(cause);
  return message.includes("statement timeout")
    ? "timeout"
    : message.slice(0, 120);
}
