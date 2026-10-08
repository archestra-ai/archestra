"use client";

import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";
import { QueryLoadError } from "@/components/query-load-error";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  type ChartConfig,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart";
import { Skeleton } from "@/components/ui/skeleton";
import { useRemediesActivity } from "@/lib/openappa-remedies.query";
import {
  blockedCallsBars,
  blockedCallsHeadline,
  blockedCallsTotals,
} from "./blocked-calls.utils";

const chartConfig = {
  remedied: { label: "approved or cleaned", color: "var(--chart-1)" },
  stayed: { label: "stayed blocked", color: "var(--muted-foreground)" },
} satisfies ChartConfig;

/**
 * The calls the runtime denied on each of the last seven days, split into
 * the ones an authority or sanitizer then let through and the ones that
 * stayed blocked.
 */
export function BlockedCallsChart() {
  const activity = useRemediesActivity();

  if (activity.isLoadingError)
    return (
      <Card className="py-5">
        <CardContent className="px-5">
          <QueryLoadError
            title="Could not load blocked calls"
            onRetry={() => activity.refetch()}
          />
        </CardContent>
      </Card>
    );

  const days = activity.data?.days ?? [];
  const totals = blockedCallsTotals(days);
  return (
    <Card className="gap-3 py-4">
      <CardHeader className="flex items-center justify-between px-4">
        <CardTitle className="text-xs font-medium">
          Blocked calls · last 7 days
        </CardTitle>
        {activity.data ? (
          <span className="text-muted-foreground text-xs">
            {blockedCallsHeadline(totals)}
          </span>
        ) : (
          <Skeleton className="h-4 w-56" />
        )}
      </CardHeader>
      <CardContent className="px-4">
        {activity.data ? (
          <ChartContainer
            config={chartConfig}
            className="aspect-auto h-36 w-full"
          >
            <BarChart
              accessibilityLayer
              data={blockedCallsBars(days)}
              margin={{ top: 4, left: 0, right: 8 }}
            >
              <CartesianGrid vertical={false} />
              <XAxis
                dataKey="label"
                tickLine={false}
                axisLine={false}
                tickMargin={8}
              />
              <YAxis
                tickLine={false}
                axisLine={false}
                tickMargin={4}
                width={32}
                allowDecimals={false}
              />
              <ChartTooltip
                cursor={{ fill: "var(--muted)", fillOpacity: 0.6 }}
                content={
                  <ChartTooltipContent
                    labelFormatter={(_, payload) => {
                      const bar = payload[0]?.payload as
                        | { date?: string }
                        | undefined;
                      return bar?.date ?? "";
                    }}
                  />
                }
              />
              <Bar
                dataKey="stayed"
                stackId="calls"
                fill="var(--color-stayed)"
                fillOpacity={0.35}
                isAnimationActive={false}
              />
              <Bar
                dataKey="remedied"
                stackId="calls"
                fill="var(--color-remedied)"
                isAnimationActive={false}
                radius={[2, 2, 0, 0]}
              />
            </BarChart>
          </ChartContainer>
        ) : (
          <Skeleton className="h-36 w-full" />
        )}
        <ul className="text-muted-foreground mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11px]">
          {(["remedied", "stayed"] as const).map((key) => (
            <li key={key} className="flex items-center gap-1">
              <span
                aria-hidden
                className="size-1.5 rounded-sm"
                style={{
                  backgroundColor: chartConfig[key].color,
                  opacity: key === "stayed" ? 0.35 : 1,
                }}
              />
              <span>{chartConfig[key].label}</span>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
