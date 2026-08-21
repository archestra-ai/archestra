"use client";

import type { StatisticsTimeFrame } from "@archestra/shared";
import { format } from "date-fns";
import { Area, AreaChart, XAxis, YAxis } from "recharts";
import { BilledCost } from "@/components/billed-cost";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  type ChartConfig,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useMyStatistics } from "@/lib/statistics.query";

/** Models shown as badges before the rest collapse into a "+N" tooltip. */
const MODEL_BADGE_LIMIT = 3;

const spendChartConfig = {
  value: { label: "Your spend", color: "var(--chart-1)" },
} satisfies ChartConfig;

/**
 * The signed-in user's own cost and usage, at the head of the Costs page.
 *
 * Everyone sees this, including people with no `llmCost:read` — it reports the
 * caller's own activity and nothing about anyone else's, which is why the
 * endpoint behind it carries no cost permission. For those users it is the whole
 * page, so it has to stand on its own: headline figures, the model mix behind
 * them, and the shape of the spend over the selected timeframe.
 */
export function MyUsageSummary({
  timeframe,
  enabled = true,
}: {
  timeframe: StatisticsTimeFrame;
  /** Held false until the page has resolved which timeframe to ask for. */
  enabled?: boolean;
}) {
  const { data: stats, isPending } = useMyStatistics({ timeframe, enabled });

  const spendChartData = (stats?.timeSeries ?? []).map((point) => ({
    label: format(new Date(point.timestamp), "MMM d, HH:mm"),
    value: point.value,
  }));
  // A single bucket draws no line, only a lone dot — not worth the chart's
  // vertical space, and the headline figure already says what it would say.
  const showSpendChart = spendChartData.length > 1;

  return (
    <Card data-testid="my-usage-summary">
      <CardHeader>
        <CardTitle>Your usage</CardTitle>
        <CardDescription>
          Your own activity over the selected timeframe. Only you and people who
          can read organization-wide costs see these figures.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {isPending ? (
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            {["spend", "requests", "tokens", "active-days"].map((tile) => (
              <Skeleton key={tile} className="h-20 w-full" />
            ))}
          </div>
        ) : !stats || stats.requests === 0 ? (
          <p className="text-muted-foreground py-6 text-center">
            No recorded activity for the selected timeframe.
          </p>
        ) : (
          <div className="space-y-6">
            <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
              <SummaryTile label="Spend">
                <BilledCost
                  cost={String(stats.billedCost + stats.subscriptionCost)}
                  billedCost={String(stats.billedCost)}
                  subscriptionCost={String(stats.subscriptionCost)}
                  baselineCost={String(stats.billedCost)}
                  tooltip="hover"
                  className="flex-wrap text-2xl font-semibold"
                />
              </SummaryTile>

              <SummaryTile label="Requests">
                <span className="text-2xl font-semibold">
                  {stats.requests.toLocaleString()}
                </span>
              </SummaryTile>

              <SummaryTile label="Tokens">
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="cursor-default text-2xl font-semibold underline decoration-dotted">
                      {stats.totalTokens.toLocaleString()}
                    </span>
                  </TooltipTrigger>
                  <TooltipContent className="max-w-xs">
                    <div className="space-y-0.5 text-sm">
                      <div>Input: {stats.inputTokens.toLocaleString()}</div>
                      <div>Output: {stats.outputTokens.toLocaleString()}</div>
                      <div className="text-muted-foreground">
                        Cache reads: {stats.cacheReadTokens.toLocaleString()}{" "}
                        (not counted in the total)
                      </div>
                    </div>
                  </TooltipContent>
                </Tooltip>
              </SummaryTile>

              <SummaryTile label="Active days">
                <span className="text-2xl font-semibold">
                  {stats.activeDays.toLocaleString()}
                </span>
                <span className="text-muted-foreground text-xs">
                  {stats.lastActiveAt ? (
                    <span>
                      Last active{" "}
                      {format(new Date(stats.lastActiveAt), "MMM d, HH:mm")}
                    </span>
                  ) : null}
                </span>
              </SummaryTile>
            </div>

            {stats.models.length > 0 && (
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-muted-foreground text-sm">Models</span>
                {stats.models.slice(0, MODEL_BADGE_LIMIT).map((model) => (
                  <Badge
                    key={model.model}
                    variant="secondary"
                    className="max-w-full font-normal"
                    title={model.model}
                  >
                    <span className="truncate">{model.model}</span>
                  </Badge>
                ))}
                {stats.models.length > MODEL_BADGE_LIMIT && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Badge
                        variant="outline"
                        className="cursor-default font-normal"
                      >
                        +{stats.models.length - MODEL_BADGE_LIMIT}
                      </Badge>
                    </TooltipTrigger>
                    <TooltipContent className="max-w-xs">
                      {stats.models
                        .slice(MODEL_BADGE_LIMIT)
                        .map((model) => model.model)
                        .join(", ")}
                    </TooltipContent>
                  </Tooltip>
                )}
              </div>
            )}

            {showSpendChart && (
              <ChartContainer
                config={spendChartConfig}
                className="aspect-auto h-40 w-full"
              >
                <AreaChart
                  accessibilityLayer
                  data={spendChartData}
                  margin={{ top: 8, left: 12, right: 12 }}
                >
                  <XAxis
                    dataKey="label"
                    tickLine={false}
                    axisLine={false}
                    tickMargin={8}
                  />
                  <YAxis
                    tickLine={false}
                    axisLine={false}
                    tickMargin={8}
                    tickFormatter={(value) => `$${value}`}
                  />
                  <ChartTooltip
                    content={
                      <ChartTooltipContent
                        indicator="dot"
                        formatter={(value) => (
                          <span className="text-foreground font-mono font-medium tabular-nums">
                            ${Number(value).toFixed(2)}
                          </span>
                        )}
                      />
                    }
                  />
                  <Area
                    dataKey="value"
                    type="monotone"
                    stroke="var(--color-value)"
                    fill="var(--color-value)"
                    fillOpacity={0.15}
                    strokeWidth={2}
                  />
                </AreaChart>
              </ChartContainer>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function SummaryTile({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1 rounded-md border p-4">
      <span className="text-muted-foreground text-xs uppercase tracking-wide">
        {label}
      </span>
      {children}
    </div>
  );
}
