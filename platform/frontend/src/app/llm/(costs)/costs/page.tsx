"use client";

import {
  type archestraApiTypes,
  parseCustomStatisticsTimeframe,
  type StatisticsTimeFrame,
  StatisticsTimeFrameSchema,
} from "@archestra/shared";
import { format } from "date-fns";
import { Calendar as CalendarIcon, Clock } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { CartesianGrid, Line, LineChart, XAxis, YAxis } from "recharts";
import { useSetCostsAction } from "@/app/llm/(costs)/layout";
import { BilledCost } from "@/components/billed-cost";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart";
import { CustomDateTimeRangeDialog } from "@/components/ui/custom-date-time-range-dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useAppName } from "@/lib/hooks/use-app-name";
import {
  useAppStatistics,
  useCostSavingsStatistics,
  useModelStatistics,
  useProfileStatistics,
  useSkillStatistics,
  useTeamStatistics,
  useUserStatistics,
} from "@/lib/statistics.query";
import { formatStatisticsAxisLabel } from "./format-axis-label";

/**
 * Reusable tooltip component for cost charts.
 * Shows a color dot indicator and formatted cost value for each data series.
 */
const CostChartTooltip = (
  <ChartTooltipContent
    indicator="dot"
    formatter={(value, _name, item) => (
      <>
        <div
          className="shrink-0 rounded-[2px] h-2.5 w-2.5"
          style={{
            backgroundColor: item.color || item.fill,
          }}
        />
        <span className="text-foreground font-mono font-medium tabular-nums">
          ${Number(value).toFixed(2)}
        </span>
      </>
    )}
  />
);

interface ChartContainerWrapperProps {
  config: ChartConfig;
  data: Record<string, string | number>[];
  emptyMessage?: string;
  children: React.ReactNode;
}

const ChartContainerWrapper = ({
  config,
  data,
  emptyMessage = "No data available",
  children,
}: ChartContainerWrapperProps) => (
  <ChartContainer config={config} className="aspect-auto h-80 w-full relative">
    {data.length > 0 ? (
      children
    ) : (
      <div className="absolute inset-0 flex items-center justify-center text-muted-foreground">
        {emptyMessage}
      </div>
    )}
  </ChartContainer>
);

const TIMEFRAME_STORAGE_KEY = "cost-statistics-timeframe";
const STATISTICS_TABLE_MAX_HEIGHT_CLASS = "max-h-[280px]";
/**
 * The per-user endpoint is paginated because user cardinality is unbounded;
 * this page renders a leaderboard rather than the full roster.
 */
const USER_STATISTICS_PAGE_SIZE = 10;
const USER_MODEL_BADGE_LIMIT = 2;
/** Apps and skills are paginated for the same reason as people. */
const ENTITY_STATISTICS_PAGE_SIZE = 10;
/**
 * Recharts series keys double as CSS custom-property names (`--color-<key>`,
 * see ChartStyle in components/ui/chart). Model ids such as
 * `anthropic/claude-opus-4.8` contain `/` and `.`, which are not valid in a
 * property name, so a chart keyed by the raw id gets no line stroke, black
 * dots and colourless legend/tooltip swatches. Model series are keyed by
 * rank instead; the chart config carries the real id as the label.
 */
const modelSeriesKey = (rank: number) => `model-${rank}`;

export default function StatisticsPage() {
  const router = useRouter();
  const setActionButton = useSetCostsAction();
  const searchParams = useSearchParams();
  const appName = useAppName();

  const [timeframe, setTimeframe] = useState<StatisticsTimeFrame>("1h");
  // The real timeframe (URL param or localStorage) is only known once the
  // init effect below has run; hold the statistics queries until then so a
  // page load doesn't fire a throwaway round of default-timeframe requests
  // that gets discarded one render later.
  const [isTimeframeResolved, setIsTimeframeResolved] = useState(false);
  const [customFrom, setCustomFrom] = useState<Date | undefined>();
  const [customTo, setCustomTo] = useState<Date | undefined>();
  const [isCustomDialogOpen, setIsCustomDialogOpen] = useState(false);

  // Statistics data fetching hooks
  const { data: teamStatistics = [] } = useTeamStatistics({
    timeframe,
    enabled: isTimeframeResolved,
  });
  const { data: agentStatistics = [] } = useProfileStatistics({
    timeframe,
    enabled: isTimeframeResolved,
  });
  const { data: modelStatistics = [] } = useModelStatistics({
    timeframe,
    enabled: isTimeframeResolved,
  });
  const { data: costSavingsData } = useCostSavingsStatistics({
    timeframe,
    enabled: isTimeframeResolved,
  });
  const { data: userStatisticsPage } = useUserStatistics({
    timeframe,
    limit: USER_STATISTICS_PAGE_SIZE,
    includeModels: true,
    enabled: isTimeframeResolved,
  });
  const userStatistics = userStatisticsPage?.data ?? [];
  const userStatisticsTotal = userStatisticsPage?.pagination?.total ?? 0;
  const { data: appStatisticsPage } = useAppStatistics({
    timeframe,
    limit: ENTITY_STATISTICS_PAGE_SIZE,
    enabled: isTimeframeResolved,
  });
  const appStatistics = appStatisticsPage?.data ?? [];
  const appStatisticsTotal = appStatisticsPage?.pagination?.total ?? 0;
  const chatBaselineCostPerSession =
    appStatisticsPage?.chatBaselineCostPerSession ?? 0;
  const chatBaselineSessions = appStatisticsPage?.chatBaselineSessions ?? 0;
  const { data: skillStatisticsPage } = useSkillStatistics({
    timeframe,
    limit: ENTITY_STATISTICS_PAGE_SIZE,
    enabled: isTimeframeResolved,
  });
  const skillStatistics = skillStatisticsPage?.data ?? [];
  const skillStatisticsTotal = skillStatisticsPage?.pagination?.total ?? 0;

  /**
   * Initialize from URL parameters or localStorage
   */
  useEffect(() => {
    const urlTimeframe = searchParams.get("timeframe");
    const storedTimeframe = localStorage.getItem(TIMEFRAME_STORAGE_KEY);

    // URL params take precedence, then localStorage, then default
    const { success, data } = StatisticsTimeFrameSchema.safeParse(
      urlTimeframe ?? storedTimeframe,
    );
    if (success) {
      setTimeframe(data);
      const customRange = parseCustomStatisticsTimeframe(data);
      setCustomFrom(customRange?.startTime);
      setCustomTo(customRange?.endTime);
    } else {
      setTimeframe("1h");
      setCustomFrom(undefined);
      setCustomTo(undefined);
    }
    setIsTimeframeResolved(true);
  }, [searchParams]);

  // Update URL when timeframe changes
  const updateURL = useCallback(
    (newTimeframe?: string) => {
      const params = new URLSearchParams(searchParams);

      if (newTimeframe !== undefined) {
        params.set("timeframe", newTimeframe);
      }

      router.push(`/llm/costs?${params.toString()}`, {
        scroll: false,
      });
    },
    [router, searchParams],
  );

  const handleTimeframeChange = useCallback(
    (tf: StatisticsTimeFrame) => {
      setTimeframe(tf);
      localStorage.setItem(TIMEFRAME_STORAGE_KEY, tf);
      updateURL(tf);
    },
    [updateURL],
  );

  const handleCustomTimeframe = useCallback(() => {
    if (!customFrom || !customTo) return;

    const fromDateTime = new Date(customFrom);
    const toDateTime = new Date(customTo);
    toDateTime.setSeconds(59, 999);

    const customValue =
      `custom:${fromDateTime.toISOString()}_${toDateTime.toISOString()}` as const;
    handleTimeframeChange(customValue);
    setIsCustomDialogOpen(false);
  }, [customFrom, customTo, handleTimeframeChange]);

  const getTimeframeDisplay = useCallback((tf: StatisticsTimeFrame) => {
    // Falls through to the preset labels below when the bounds are unparseable,
    // rather than formatting an Invalid Date and taking the page down with it.
    const customRange = parseCustomStatisticsTimeframe(tf);
    if (customRange) {
      const { startTime, endTime } = customRange;
      // A range picked as whole days runs local midnight to 23:59; any other
      // bound was given an explicit time that belongs in the label.
      const isWholeDayRange =
        startTime.getHours() === 0 &&
        startTime.getMinutes() === 0 &&
        endTime.getHours() === 23 &&
        endTime.getMinutes() === 59;
      const pattern = isWholeDayRange ? "MMM d" : "MMM d, HH:mm";

      return `${format(startTime, pattern)} - ${format(endTime, pattern)}`;
    }
    switch (tf) {
      case "1h":
        return "hour";
      case "24h":
        return "24 hours";
      case "7d":
        return "7 days";
      case "30d":
        return "30 days";
      case "90d":
        return "90 days";
      case "12m":
        return "12 months";
      case "all":
        return "";
      default:
        return tf;
    }
  }, []);

  const formatTimestamp = useCallback(
    (timestamp: string) => formatStatisticsAxisLabel(timestamp, timeframe),
    [timeframe],
  );

  // Filter agent statistics by type
  const chatAgentStatistics = useMemo(
    () => agentStatistics.filter((stat) => stat.agentType === "agent"),
    [agentStatistics],
  );
  const llmProxyStatistics = useMemo(
    () => agentStatistics.filter((stat) => stat.agentType === "llm_proxy"),
    [agentStatistics],
  );

  // The API returns entities in first-seen order, not by cost. Both the
  // tables and the "top 5 by cost" charts below need the cost order.
  const sortedTeamStatistics = useMemo(
    () => [...teamStatistics].sort((a, b) => b.cost - a.cost),
    [teamStatistics],
  );
  const sortedChatAgentStatistics = useMemo(
    () => [...chatAgentStatistics].sort((a, b) => b.cost - a.cost),
    [chatAgentStatistics],
  );
  const sortedLlmProxyStatistics = useMemo(
    () => [...llmProxyStatistics].sort((a, b) => b.cost - a.cost),
    [llmProxyStatistics],
  );
  const sortedModelStatistics = useMemo(
    () => [...modelStatistics].sort((a, b) => b.cost - a.cost),
    [modelStatistics],
  );

  // Convert team statistics to recharts format
  const teamChartData = useMemo(() => {
    if (sortedTeamStatistics.length === 0) return [];

    const allTimestamps = [
      ...new Set(
        sortedTeamStatistics.flatMap((stat) =>
          stat.timeSeries.map((point) => point.timestamp),
        ),
      ),
    ].sort();

    return allTimestamps.map((timestamp) => {
      const dataPoint: Record<string, string | number> = {
        timestamp,
        label: formatTimestamp(timestamp),
      };
      sortedTeamStatistics.slice(0, 5).forEach((team) => {
        const point = team.timeSeries.find((p) => p.timestamp === timestamp);
        dataPoint[team.teamId] = point ? point.value : 0;
      });
      return dataPoint;
    });
  }, [sortedTeamStatistics, formatTimestamp]);

  const teamChartConfig = useMemo(() => {
    const config: ChartConfig = {};
    sortedTeamStatistics.slice(0, 5).forEach((team, index) => {
      config[team.teamId] = {
        label: team.teamName,
        color: `var(--chart-${index + 1})`,
      };
    });
    return config;
  }, [sortedTeamStatistics]);

  // Convert agent statistics to recharts format
  const agentChartData = useMemo(() => {
    if (sortedChatAgentStatistics.length === 0) return [];

    const allTimestamps = [
      ...new Set(
        sortedChatAgentStatistics.flatMap((stat) =>
          stat.timeSeries.map((point) => point.timestamp),
        ),
      ),
    ].sort();

    return allTimestamps.map((timestamp) => {
      const dataPoint: Record<string, string | number> = {
        timestamp,
        label: formatTimestamp(timestamp),
      };
      sortedChatAgentStatistics.slice(0, 5).forEach((agent) => {
        const point = agent.timeSeries.find((p) => p.timestamp === timestamp);
        dataPoint[agent.agentId] = point ? point.value : 0;
      });
      return dataPoint;
    });
  }, [sortedChatAgentStatistics, formatTimestamp]);

  const agentChartConfig = useMemo(() => {
    const config: ChartConfig = {};
    sortedChatAgentStatistics.slice(0, 5).forEach((agent, index) => {
      config[agent.agentId] = {
        label: agent.agentName,
        color: `var(--chart-${index + 1})`,
      };
    });
    return config;
  }, [sortedChatAgentStatistics]);

  // Convert LLM proxy statistics to recharts format
  const llmProxyChartData = useMemo(() => {
    if (sortedLlmProxyStatistics.length === 0) return [];

    const allTimestamps = [
      ...new Set(
        sortedLlmProxyStatistics.flatMap((stat) =>
          stat.timeSeries.map((point) => point.timestamp),
        ),
      ),
    ].sort();

    return allTimestamps.map((timestamp) => {
      const dataPoint: Record<string, string | number> = {
        timestamp,
        label: formatTimestamp(timestamp),
      };
      sortedLlmProxyStatistics.slice(0, 5).forEach((agent) => {
        const point = agent.timeSeries.find((p) => p.timestamp === timestamp);
        dataPoint[agent.agentId] = point ? point.value : 0;
      });
      return dataPoint;
    });
  }, [sortedLlmProxyStatistics, formatTimestamp]);

  const llmProxyChartConfig = useMemo(() => {
    const config: ChartConfig = {};
    sortedLlmProxyStatistics.slice(0, 5).forEach((agent, index) => {
      config[agent.agentId] = {
        label: agent.agentName,
        color: `var(--chart-${index + 1})`,
      };
    });
    return config;
  }, [sortedLlmProxyStatistics]);

  // Convert model statistics to recharts format
  const modelChartData = useMemo(() => {
    if (sortedModelStatistics.length === 0) return [];

    const allTimestamps = [
      ...new Set(
        sortedModelStatistics.flatMap((stat) =>
          stat.timeSeries.map((point) => point.timestamp),
        ),
      ),
    ].sort();

    return allTimestamps.map((timestamp) => {
      const dataPoint: Record<string, string | number> = {
        timestamp,
        label: formatTimestamp(timestamp),
      };
      sortedModelStatistics.slice(0, 5).forEach((model, rank) => {
        const point = model.timeSeries.find((p) => p.timestamp === timestamp);
        dataPoint[modelSeriesKey(rank)] = point ? point.value : 0;
      });
      return dataPoint;
    });
  }, [sortedModelStatistics, formatTimestamp]);

  const modelChartConfig = useMemo(() => {
    const config: ChartConfig = {};
    sortedModelStatistics.slice(0, 5).forEach((model, rank) => {
      config[modelSeriesKey(rank)] = {
        label: model.model,
        color: `var(--chart-${rank + 1})`,
      };
    });
    return config;
  }, [sortedModelStatistics]);

  // Cost savings chart data
  const costSavingsChartData = useMemo(() => {
    if (!costSavingsData || costSavingsData.timeSeries.length === 0) return [];

    return costSavingsData.timeSeries.map((point) => ({
      timestamp: point.timestamp,
      label: formatTimestamp(point.timestamp),
      nonOptimized: point.baselineCost,
      actual: point.actualCost,
      subscription: point.subscriptionCost,
    }));
  }, [costSavingsData, formatTimestamp]);

  // Whether any subscription-covered (unbilled) usage exists in the window, so
  // the extra series/legend only appears when it's relevant.
  const hasSubscriptionCost = (costSavingsData?.totalSubscriptionCost ?? 0) > 0;

  const costSavingsChartConfig: ChartConfig = {
    nonOptimized: {
      label: "Non-Optimized Cost",
      color: "var(--chart-4)",
    },
    actual: {
      label: "Actual Cost (Billed)",
      color: "var(--chart-2)",
    },
    ...(hasSubscriptionCost
      ? {
          subscription: {
            label: "Subscription (Not Billed)",
            color: "var(--chart-5)",
          },
        }
      : {}),
  };

  // Savings breakdown chart data
  const savingsBreakdownChartData = useMemo(() => {
    if (!costSavingsData || costSavingsData.timeSeries.length === 0) return [];

    return costSavingsData.timeSeries.map((point) => ({
      timestamp: point.timestamp,
      label: formatTimestamp(point.timestamp),
      optimization: point.optimizationSavings,
      compression: point.toonSavings,
      cache: point.cacheSavings,
    }));
  }, [costSavingsData, formatTimestamp]);

  const savingsBreakdownChartConfig: ChartConfig = {
    optimization: {
      label: "Optimization Rules Savings",
      color: "var(--chart-1)",
    },
    compression: {
      label: "Tool Compression Savings",
      color: "var(--chart-5)",
    },
    cache: {
      label: "Prompt Cache Savings",
      color: "var(--chart-3)",
    },
  };

  useEffect(() => {
    setActionButton(
      <div className="flex gap-2">
        <Select
          value={timeframe.startsWith("custom:") ? "custom" : timeframe}
          onValueChange={(value) => {
            if (value === "custom") {
              setIsCustomDialogOpen(true);
            } else {
              handleTimeframeChange(value as StatisticsTimeFrame);
            }
          }}
        >
          <SelectTrigger className="w-[320px]">
            <CalendarIcon className="mr-2 h-4 w-4" />
            <SelectValue>
              {timeframe.startsWith("custom:")
                ? `Custom: ${getTimeframeDisplay(timeframe)}`
                : timeframe === "all"
                  ? "All time"
                  : `Last ${getTimeframeDisplay(timeframe)}`}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="5m">5 Minutes</SelectItem>
            <SelectItem value="15m">15 Minutes</SelectItem>
            <SelectItem value="30m">30 Minutes</SelectItem>
            <SelectItem value="1h">Last hour</SelectItem>
            <SelectItem value="24h">Last 24 hours</SelectItem>
            <SelectItem value="7d">Last 7 days</SelectItem>
            <SelectItem value="30d">Last 30 days</SelectItem>
            <SelectItem value="90d">Last 90 days</SelectItem>
            <SelectItem value="12m">Last 12 months</SelectItem>
            <SelectItem value="all">All time</SelectItem>
            <SelectItem value="custom">
              <Clock className="mr-2 h-4 w-4 inline" />
              Custom timeframe...
            </SelectItem>
          </SelectContent>
        </Select>

        {timeframe.startsWith("custom:") && (
          <Button
            variant="outline"
            onClick={() => setIsCustomDialogOpen(true)}
            className="h-9 flex items-center gap-1 px-3"
          >
            <Clock className="h-4 w-4" />
            Edit
          </Button>
        )}
      </div>,
    );

    return () => setActionButton(null);
  }, [getTimeframeDisplay, handleTimeframeChange, setActionButton, timeframe]);

  return (
    <div className="space-y-6">
      <CustomDateTimeRangeDialog
        open={isCustomDialogOpen}
        onOpenChange={setIsCustomDialogOpen}
        startDate={customFrom}
        endDate={customTo}
        onStartDateChange={setCustomFrom}
        onEndDateChange={setCustomTo}
        onApply={handleCustomTimeframe}
        title="Custom timeframe"
        description="Set a custom time period for the statistics view."
      />

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card>
          <CardHeader>
            <CardTitle>Costs</CardTitle>
          </CardHeader>
          <CardContent>
            <ChartContainerWrapper
              config={costSavingsChartConfig}
              data={costSavingsChartData}
            >
              <LineChart
                accessibilityLayer
                data={costSavingsChartData}
                margin={{ top: 12, left: 12, right: 12 }}
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
                  tickMargin={8}
                  tickFormatter={(value) => `$${value}`}
                />
                <ChartTooltip content={CostChartTooltip} />
                <ChartLegend content={<ChartLegendContent />} />
                <Line
                  dataKey="nonOptimized"
                  type="monotone"
                  stroke="var(--color-nonOptimized)"
                  strokeWidth={2}
                  dot={{
                    strokeWidth: 0,
                    r: 3,
                    fill: "var(--color-nonOptimized)",
                  }}
                  activeDot={{ strokeWidth: 0, r: 5 }}
                />
                <Line
                  dataKey="actual"
                  type="monotone"
                  stroke="var(--color-actual)"
                  strokeWidth={2}
                  dot={{ strokeWidth: 0, r: 3, fill: "var(--color-actual)" }}
                  activeDot={{ strokeWidth: 0, r: 5 }}
                />
                {hasSubscriptionCost && (
                  <Line
                    dataKey="subscription"
                    type="monotone"
                    stroke="var(--color-subscription)"
                    strokeWidth={2}
                    strokeDasharray="4 4"
                    dot={{
                      strokeWidth: 0,
                      r: 3,
                      fill: "var(--color-subscription)",
                    }}
                    activeDot={{ strokeWidth: 0, r: 5 }}
                  />
                )}
              </LineChart>
            </ChartContainerWrapper>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Cost Savings</CardTitle>
          </CardHeader>
          <CardContent>
            <ChartContainerWrapper
              config={savingsBreakdownChartConfig}
              data={savingsBreakdownChartData}
            >
              <LineChart
                accessibilityLayer
                data={savingsBreakdownChartData}
                margin={{ top: 12, left: 12, right: 12 }}
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
                  tickMargin={8}
                  tickFormatter={(value) => `$${value}`}
                />
                <ChartTooltip content={CostChartTooltip} />
                <ChartLegend content={<ChartLegendContent />} />
                <Line
                  dataKey="optimization"
                  type="monotone"
                  stroke="var(--color-optimization)"
                  strokeWidth={2}
                  dot={{
                    strokeWidth: 0,
                    r: 3,
                    fill: "var(--color-optimization)",
                  }}
                  activeDot={{ strokeWidth: 0, r: 5 }}
                />
                <Line
                  dataKey="compression"
                  type="monotone"
                  stroke="var(--color-compression)"
                  strokeWidth={2}
                  dot={{
                    strokeWidth: 0,
                    r: 3,
                    fill: "var(--color-compression)",
                  }}
                  activeDot={{ strokeWidth: 0, r: 5 }}
                />
                <Line
                  dataKey="cache"
                  type="monotone"
                  stroke="var(--color-cache)"
                  strokeWidth={2}
                  dot={{
                    strokeWidth: 0,
                    r: 3,
                    fill: "var(--color-cache)",
                  }}
                  activeDot={{ strokeWidth: 0, r: 5 }}
                />
              </LineChart>
            </ChartContainerWrapper>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Teams</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-4">
            <div className="space-y-3">
              <ChartContainerWrapper
                config={teamChartConfig}
                data={teamChartData}
                emptyMessage="No team data available"
              >
                <LineChart
                  accessibilityLayer
                  data={teamChartData}
                  margin={{ top: 12, left: 12, right: 12 }}
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
                    tickMargin={8}
                    tickFormatter={(value) => `$${value}`}
                  />
                  <ChartTooltip content={CostChartTooltip} />
                  <ChartLegend content={<ChartLegendContent />} />
                  {sortedTeamStatistics.slice(0, 5).map((team) => (
                    <Line
                      key={team.teamId}
                      dataKey={team.teamId}
                      type="monotone"
                      stroke={`var(--color-${team.teamId})`}
                      strokeWidth={2}
                      dot={{
                        strokeWidth: 0,
                        r: 3,
                        fill: `var(--color-${team.teamId})`,
                      }}
                      activeDot={{ strokeWidth: 0, r: 5 }}
                    />
                  ))}
                </LineChart>
              </ChartContainerWrapper>
              {teamStatistics.length > 5 && (
                <p className="text-xs text-muted-foreground text-center mt-2">
                  Chart shows top 5 by cost
                </p>
              )}
            </div>

            <StatisticsTablePanel>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="bg-card sticky top-0 z-10">
                      Team Name
                    </TableHead>
                    <TableHead className="bg-card sticky top-0 z-10">
                      Members
                    </TableHead>
                    <TableHead className="bg-card sticky top-0 z-10">
                      Profiles
                    </TableHead>
                    <TableHead className="bg-card sticky top-0 z-10">
                      Requests
                    </TableHead>
                    <TableHead className="bg-card sticky top-0 z-10">
                      Tokens
                    </TableHead>
                    <TableHead className="bg-card sticky top-0 z-10 text-right">
                      Cost
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {sortedTeamStatistics.length === 0 ? (
                    <TableRow>
                      <TableCell
                        colSpan={6}
                        className="text-center py-8 text-muted-foreground"
                      >
                        No team data available for the selected timeframe
                      </TableCell>
                    </TableRow>
                  ) : (
                    sortedTeamStatistics.map((team) => (
                      <TableRow key={team.teamId}>
                        <TableCell className="font-medium">
                          {team.teamName}
                        </TableCell>
                        <TableCell>{team.members}</TableCell>
                        <TableCell>{team.agents}</TableCell>
                        <TableCell>{team.requests.toLocaleString()}</TableCell>
                        <TableCell>
                          {(
                            team.inputTokens + team.outputTokens
                          ).toLocaleString()}
                        </TableCell>
                        <TableCell className="text-right">
                          ${team.cost.toFixed(2)}
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </StatisticsTablePanel>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Agents</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-4">
            <div className="space-y-3">
              <ChartContainerWrapper
                config={agentChartConfig}
                data={agentChartData}
                emptyMessage="No agent data available"
              >
                <LineChart
                  accessibilityLayer
                  data={agentChartData}
                  margin={{ top: 12, left: 12, right: 12 }}
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
                    tickMargin={8}
                    tickFormatter={(value) => `$${value}`}
                  />
                  <ChartTooltip content={CostChartTooltip} />
                  <ChartLegend content={<ChartLegendContent />} />
                  {sortedChatAgentStatistics.slice(0, 5).map((agent) => (
                    <Line
                      key={agent.agentId}
                      dataKey={agent.agentId}
                      type="monotone"
                      stroke={`var(--color-${agent.agentId})`}
                      strokeWidth={2}
                      dot={{
                        strokeWidth: 0,
                        r: 3,
                        fill: `var(--color-${agent.agentId})`,
                      }}
                      activeDot={{ strokeWidth: 0, r: 5 }}
                    />
                  ))}
                </LineChart>
              </ChartContainerWrapper>
              {chatAgentStatistics.length > 5 && (
                <p className="text-xs text-muted-foreground text-center mt-2">
                  Chart shows top 5 by cost
                </p>
              )}
            </div>

            <StatisticsTablePanel>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="bg-card sticky top-0 z-10">
                      Name
                    </TableHead>
                    <TableHead className="bg-card sticky top-0 z-10">
                      Team
                    </TableHead>
                    <TableHead className="bg-card sticky top-0 z-10">
                      Requests
                    </TableHead>
                    <TableHead className="bg-card sticky top-0 z-10">
                      Tokens
                    </TableHead>
                    <TableHead className="bg-card sticky top-0 z-10">
                      Cache read
                    </TableHead>
                    <TableHead className="bg-card sticky top-0 z-10 text-right">
                      Cost
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {sortedChatAgentStatistics.length === 0 ? (
                    <TableRow>
                      <TableCell
                        colSpan={6}
                        className="text-center py-8 text-muted-foreground"
                      >
                        No agent data available for the selected timeframe
                      </TableCell>
                    </TableRow>
                  ) : (
                    sortedChatAgentStatistics.map((agent) => (
                      <TableRow key={agent.agentId}>
                        <TableCell className="font-medium">
                          {agent.agentName}
                        </TableCell>
                        <TableCell>{agent.teamName}</TableCell>
                        <TableCell>{agent.requests.toLocaleString()}</TableCell>
                        <TableCell>
                          {(
                            agent.inputTokens + agent.outputTokens
                          ).toLocaleString()}
                        </TableCell>
                        <TableCell>
                          {(agent.cacheReadTokens ?? 0).toLocaleString()}
                        </TableCell>
                        <TableCell className="text-right">
                          ${agent.cost.toFixed(2)}
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </StatisticsTablePanel>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>LLM Proxies</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-4">
            <div className="space-y-3">
              <ChartContainerWrapper
                config={llmProxyChartConfig}
                data={llmProxyChartData}
                emptyMessage="No LLM proxy data available"
              >
                <LineChart
                  accessibilityLayer
                  data={llmProxyChartData}
                  margin={{ top: 12, left: 12, right: 12 }}
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
                    tickMargin={8}
                    tickFormatter={(value) => `$${value}`}
                  />
                  <ChartTooltip content={CostChartTooltip} />
                  <ChartLegend content={<ChartLegendContent />} />
                  {sortedLlmProxyStatistics.slice(0, 5).map((proxy) => (
                    <Line
                      key={proxy.agentId}
                      dataKey={proxy.agentId}
                      type="monotone"
                      stroke={`var(--color-${proxy.agentId})`}
                      strokeWidth={2}
                      dot={{
                        strokeWidth: 0,
                        r: 3,
                        fill: `var(--color-${proxy.agentId})`,
                      }}
                      activeDot={{ strokeWidth: 0, r: 5 }}
                    />
                  ))}
                </LineChart>
              </ChartContainerWrapper>
              {llmProxyStatistics.length > 5 && (
                <p className="text-xs text-muted-foreground text-center mt-2">
                  Chart shows top 5 by cost
                </p>
              )}
            </div>

            <StatisticsTablePanel>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="bg-card sticky top-0 z-10">
                      Name
                    </TableHead>
                    <TableHead className="bg-card sticky top-0 z-10">
                      Team
                    </TableHead>
                    <TableHead className="bg-card sticky top-0 z-10">
                      Requests
                    </TableHead>
                    <TableHead className="bg-card sticky top-0 z-10">
                      Tokens
                    </TableHead>
                    <TableHead className="bg-card sticky top-0 z-10 text-right">
                      Cost
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {sortedLlmProxyStatistics.length === 0 ? (
                    <TableRow>
                      <TableCell
                        colSpan={5}
                        className="text-center py-8 text-muted-foreground"
                      >
                        No LLM proxy data available for the selected timeframe
                      </TableCell>
                    </TableRow>
                  ) : (
                    sortedLlmProxyStatistics.map((proxy) => (
                      <TableRow key={proxy.agentId}>
                        <TableCell className="font-medium">
                          {proxy.agentName}
                        </TableCell>
                        <TableCell>{proxy.teamName}</TableCell>
                        <TableCell>{proxy.requests.toLocaleString()}</TableCell>
                        <TableCell>
                          {(
                            proxy.inputTokens + proxy.outputTokens
                          ).toLocaleString()}
                        </TableCell>
                        <TableCell className="text-right">
                          ${proxy.cost.toFixed(2)}
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </StatisticsTablePanel>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Models</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-4">
            <div className="space-y-3">
              <ChartContainerWrapper
                config={modelChartConfig}
                data={modelChartData}
                emptyMessage="No model data available"
              >
                <LineChart
                  accessibilityLayer
                  data={modelChartData}
                  margin={{ top: 12, left: 12, right: 12 }}
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
                    tickMargin={8}
                    tickFormatter={(value) => `$${value}`}
                  />
                  <ChartTooltip content={CostChartTooltip} />
                  <ChartLegend content={<ChartLegendContent />} />
                  {sortedModelStatistics.slice(0, 5).map((model, rank) => (
                    <Line
                      key={model.model}
                      dataKey={modelSeriesKey(rank)}
                      type="monotone"
                      stroke={`var(--color-${modelSeriesKey(rank)})`}
                      strokeWidth={2}
                      dot={{
                        strokeWidth: 0,
                        r: 3,
                        fill: `var(--color-${modelSeriesKey(rank)})`,
                      }}
                      activeDot={{ strokeWidth: 0, r: 5 }}
                    />
                  ))}
                </LineChart>
              </ChartContainerWrapper>
              {modelStatistics.length > 5 && (
                <p className="text-xs text-muted-foreground text-center mt-2">
                  Chart shows top 5 by cost
                </p>
              )}
            </div>

            <StatisticsTablePanel>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="bg-card sticky top-0 z-10">
                      Model
                    </TableHead>
                    <TableHead className="bg-card sticky top-0 z-10">
                      Requests
                    </TableHead>
                    <TableHead className="bg-card sticky top-0 z-10">
                      Tokens Used
                    </TableHead>
                    <TableHead className="bg-card sticky top-0 z-10">
                      Cache read
                    </TableHead>
                    <TableHead className="bg-card sticky top-0 z-10">
                      Cost
                    </TableHead>
                    <TableHead className="bg-card sticky top-0 z-10 text-right">
                      % of Total
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {sortedModelStatistics.length === 0 ? (
                    <TableRow>
                      <TableCell
                        colSpan={6}
                        className="text-center py-8 text-muted-foreground"
                      >
                        No model data available for the selected timeframe
                      </TableCell>
                    </TableRow>
                  ) : (
                    sortedModelStatistics.map((model) => (
                      <TableRow key={model.model}>
                        <TableCell className="font-medium">
                          {model.model}
                        </TableCell>
                        <TableCell>{model.requests.toLocaleString()}</TableCell>
                        <TableCell>
                          {(
                            model.inputTokens + model.outputTokens
                          ).toLocaleString()}
                        </TableCell>
                        <TableCell>
                          {(model.cacheReadTokens ?? 0).toLocaleString()}
                        </TableCell>
                        <TableCell>${model.cost.toFixed(2)}</TableCell>
                        <TableCell className="text-right">
                          {model.percentage.toFixed(1)}%
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </StatisticsTablePanel>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>People</CardTitle>
          <CardDescription>
            Who is using {appName}, and on which models. Requests without a
            resolved user identity are not attributed to anyone and do not
            appear here.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <StatisticsTablePanel>
            {/*
              `table-fixed` splits width equally without explicit widths, and
              badges neither wrap nor shrink — too narrow a share and they
              overflow their cell onto the next column. The floor width makes
              the panel scroll rather than crush the columns.
            */}
            <Table className="min-w-[900px]">
              <TableHeader>
                <TableRow>
                  <TableHead className="bg-card sticky top-0 z-10 w-[18%]">
                    User
                  </TableHead>
                  <TableHead className="bg-card sticky top-0 z-10 w-[10%]">
                    Requests
                  </TableHead>
                  <TableHead className="bg-card sticky top-0 z-10 w-[13%]">
                    Tokens Used
                  </TableHead>
                  <TableHead className="bg-card sticky top-0 z-10 w-[21%]">
                    Models
                  </TableHead>
                  <TableHead className="bg-card sticky top-0 z-10 w-[11%]">
                    Active Days
                  </TableHead>
                  <TableHead className="bg-card sticky top-0 z-10 w-[16%]">
                    Cost
                  </TableHead>
                  <TableHead className="bg-card sticky top-0 z-10 w-[11%] text-right">
                    Last Active
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {userStatistics.length === 0 ? (
                  <TableRow>
                    <TableCell
                      colSpan={7}
                      className="text-center py-8 text-muted-foreground"
                    >
                      No attributed user activity for the selected timeframe
                    </TableCell>
                  </TableRow>
                ) : (
                  userStatistics.map((user) => (
                    <TableRow key={user.userId}>
                      <TableCell>
                        <div
                          className="font-medium truncate"
                          title={user.userName}
                        >
                          {user.userName}
                        </div>
                        <div
                          className="text-xs text-muted-foreground truncate"
                          title={user.userEmail}
                        >
                          {user.userEmail}
                        </div>
                      </TableCell>
                      <TableCell>{user.requests.toLocaleString()}</TableCell>
                      <TableCell>{user.totalTokens.toLocaleString()}</TableCell>
                      <TableCell>
                        <UserModelBadges models={user.models} />
                      </TableCell>
                      <TableCell>{user.activeDays}</TableCell>
                      <TableCell>
                        <BilledCost
                          cost={String(user.billedCost + user.subscriptionCost)}
                          billedCost={String(user.billedCost)}
                          subscriptionCost={String(user.subscriptionCost)}
                          baselineCost={String(user.billedCost)}
                          tooltip="hover"
                          className="flex-wrap"
                        />
                      </TableCell>
                      <TableCell className="text-right text-muted-foreground">
                        {user.lastActiveAt
                          ? format(new Date(user.lastActiveAt), "MMM d, HH:mm")
                          : "—"}
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </StatisticsTablePanel>
          {userStatisticsTotal > USER_STATISTICS_PAGE_SIZE && (
            <p className="text-xs text-muted-foreground text-center mt-2">
              Showing top {USER_STATISTICS_PAGE_SIZE} of{" "}
              {userStatisticsTotal.toLocaleString()} people by tokens used
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Apps</CardTitle>
          <CardDescription>
            What each app cost to build, and what it costs to run. Building an
            app is a one-off spend; running it is UI and tool calls, plus any
            LLM completions the app itself requests. The chat-equivalent
            estimate assumes one run of an app replaces one chat session, priced
            at this organization&apos;s measured average
            {chatBaselineSessions > 0 ? (
              <span>
                {" "}
                of ${chatBaselineCostPerSession.toFixed(2)} across{" "}
                {chatBaselineSessions.toLocaleString()}{" "}
                {chatBaselineSessions === 1 ? "chat session" : "chat sessions"}{" "}
                in this period.
              </span>
            ) : (
              <span>
                {" "}
                — no chat sessions in this period, so no estimate is made.
              </span>
            )}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <StatisticsTablePanel>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="bg-card sticky top-0 z-10">
                    App
                  </TableHead>
                  <TableHead className="bg-card sticky top-0 z-10">
                    Runs
                  </TableHead>
                  <TableHead className="bg-card sticky top-0 z-10">
                    Tool calls
                  </TableHead>
                  <TableHead className="bg-card sticky top-0 z-10 text-right">
                    Build cost
                  </TableHead>
                  <TableHead className="bg-card sticky top-0 z-10 text-right">
                    Runtime cost
                  </TableHead>
                  <TableHead className="bg-card sticky top-0 z-10 text-right">
                    As chat (est.)
                  </TableHead>
                  <TableHead className="bg-card sticky top-0 z-10 text-right">
                    Net saving (est.)
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {appStatistics.length === 0 ? (
                  <TableRow>
                    <TableCell
                      colSpan={7}
                      className="text-center py-8 text-muted-foreground"
                    >
                      {/* Every app is listed regardless of activity — an app with
                          none simply reports zeros — so an empty table means
                          there are no apps, not none in this timeframe. */}
                      No apps have been created yet
                    </TableCell>
                  </TableRow>
                ) : (
                  appStatistics.map((app) => (
                    <TableRow key={app.appId}>
                      <TableCell>
                        <div className="font-medium">{app.appName}</div>
                        <div className="text-xs text-muted-foreground">
                          {app.authorName ?? "Unknown author"}
                        </div>
                      </TableCell>
                      <TableCell>{app.runs.toLocaleString()}</TableCell>
                      <TableCell>{app.toolCalls.toLocaleString()}</TableCell>
                      <TableCell className="text-right">
                        <AppBuildCostCell app={app} />
                      </TableCell>
                      <TableCell className="text-right">
                        ${app.runtimeCost.toFixed(2)}
                      </TableCell>
                      <TableCell className="text-right text-muted-foreground">
                        ${app.estimatedChatEquivalentCost.toFixed(2)}
                      </TableCell>
                      <TableCell
                        className={`text-right ${
                          app.estimatedNetSavings < 0 ? "text-destructive" : ""
                        }`}
                      >
                        ${app.estimatedNetSavings.toFixed(2)}
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </StatisticsTablePanel>
          {appStatisticsTotal > ENTITY_STATISTICS_PAGE_SIZE && (
            <p className="text-xs text-muted-foreground text-center mt-2">
              Showing top {ENTITY_STATISTICS_PAGE_SIZE} of{" "}
              {appStatisticsTotal.toLocaleString()} apps by total cost
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Skills</CardTitle>
          <CardDescription>
            A skill works by injecting instructions into the model&apos;s
            context, so &ldquo;context&rdquo; is the tokens its activations
            added — the part of the cost that is the skill&apos;s alone.
            &ldquo;On turns that used it&rdquo; is the spend of the turns that
            then ran with the skill in context, which the skill shares with
            everything else in those turns.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <StatisticsTablePanel>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="bg-card sticky top-0 z-10">
                    Skill
                  </TableHead>
                  <TableHead className="bg-card sticky top-0 z-10">
                    Activations
                  </TableHead>
                  <TableHead className="bg-card sticky top-0 z-10">
                    People
                  </TableHead>
                  <TableHead className="bg-card sticky top-0 z-10 text-right">
                    Context tokens
                  </TableHead>
                  <TableHead className="bg-card sticky top-0 z-10 text-right">
                    Turns that used it
                  </TableHead>
                  <TableHead className="bg-card sticky top-0 z-10 text-right">
                    Cost on those turns
                  </TableHead>
                  <TableHead className="bg-card sticky top-0 z-10 text-right">
                    Last used
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {skillStatistics.length === 0 ? (
                  <TableRow>
                    <TableCell
                      colSpan={7}
                      className="text-center py-8 text-muted-foreground"
                    >
                      No skill activations for the selected timeframe
                    </TableCell>
                  </TableRow>
                ) : (
                  skillStatistics.map((skill) => (
                    <TableRow key={skill.skillId}>
                      <TableCell className="font-medium">
                        {skill.skillName}
                      </TableCell>
                      <TableCell>
                        {skill.activations.toLocaleString()}
                      </TableCell>
                      <TableCell>
                        {skill.distinctUsers.toLocaleString()}
                      </TableCell>
                      <TableCell className="text-right">
                        <SkillContextTokensCell skill={skill} />
                      </TableCell>
                      <TableCell className="text-right">
                        {skill.attributedRequests.toLocaleString()}
                      </TableCell>
                      <TableCell className="text-right">
                        ${skill.attributedCost.toFixed(2)}
                      </TableCell>
                      <TableCell className="text-right text-muted-foreground">
                        {skill.lastActivatedAt
                          ? format(
                              new Date(skill.lastActivatedAt),
                              "MMM d, HH:mm",
                            )
                          : "—"}
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </StatisticsTablePanel>
          {skillStatisticsTotal > ENTITY_STATISTICS_PAGE_SIZE && (
            <p className="text-xs text-muted-foreground text-center mt-2">
              Showing top {ENTITY_STATISTICS_PAGE_SIZE} of{" "}
              {skillStatisticsTotal.toLocaleString()} skills by context tokens
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

/**
 * An app's build cost, with the caveat attached where one applies: an app with
 * no authoring session recorded (created from the Apps page, or before the link
 * existed) has no build cost to report, and a session that built several apps
 * reports its whole spend against each of them.
 */
function AppBuildCostCell({
  app,
}: {
  app: archestraApiTypes.GetAppStatisticsResponses["200"]["data"][number];
}) {
  if (!app.hasBuildSession) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="text-muted-foreground cursor-default">—</span>
        </TooltipTrigger>
        <TooltipContent className="max-w-xs">
          No authoring session is recorded for this app, so there is no build
          spend to attribute to it.
        </TooltipContent>
      </Tooltip>
    );
  }

  if (app.buildSessionAppCount > 1) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="cursor-default underline decoration-dotted">
            ${app.buildCost.toFixed(2)}
          </span>
        </TooltipTrigger>
        <TooltipContent className="max-w-xs">
          This is the whole authoring session&apos;s spend, and that session
          also built {app.buildSessionAppCount - 1}{" "}
          {app.buildSessionAppCount === 2 ? "other app" : "other apps"} — the
          same cost is reported for each rather than being split between them.
        </TooltipContent>
      </Tooltip>
    );
  }

  return <span>${app.buildCost.toFixed(2)}</span>;
}

/**
 * A skill's injected context size, flagged when only some activations could be
 * measured — activations recorded before the measurement existed contribute
 * nothing, which would otherwise read as a smaller footprint.
 */
function SkillContextTokensCell({
  skill,
}: {
  skill: archestraApiTypes.GetSkillStatisticsResponses["200"]["data"][number];
}) {
  const unmeasured = skill.activations - skill.measuredActivations;
  if (unmeasured <= 0) {
    return <span>{skill.contextTokens.toLocaleString()}</span>;
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="cursor-default underline decoration-dotted">
          {skill.contextTokens.toLocaleString()}
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs">
        {unmeasured} of {skill.activations} activations have no recorded context
        size, so this total covers only the {skill.measuredActivations} that do.
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * A user's model mix, heaviest first. Truncated because the point is which
 * models someone reaches for, not an exhaustive list.
 */
function UserModelBadges({
  models,
}: {
  models?: archestraApiTypes.GetUserStatisticsResponses["200"]["data"][number]["models"];
}) {
  if (!models || models.length === 0) {
    return <span className="text-muted-foreground">—</span>;
  }

  const shown = models.slice(0, USER_MODEL_BADGE_LIMIT);
  const remaining = models.length - shown.length;

  return (
    <div className="flex flex-wrap items-center gap-1">
      {shown.map((model) => (
        <Badge
          key={model.model}
          variant="secondary"
          className="font-normal max-w-full"
          title={model.model}
        >
          <span className="truncate">{model.model}</span>
        </Badge>
      ))}
      {remaining > 0 && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Badge variant="outline" className="font-normal cursor-default">
              +{remaining}
            </Badge>
          </TooltipTrigger>
          <TooltipContent className="max-w-xs">
            {models
              .slice(USER_MODEL_BADGE_LIMIT)
              .map((model) => model.model)
              .join(", ")}
          </TooltipContent>
        </Tooltip>
      )}
    </div>
  );
}

function StatisticsTablePanel({ children }: { children: React.ReactNode }) {
  return (
    <div
      className={`${STATISTICS_TABLE_MAX_HEIGHT_CLASS} overflow-auto rounded-md border`}
    >
      {children}
    </div>
  );
}
