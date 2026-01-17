"use client";

import { type StatisticsTimeFrame, StatisticsTimeFrameSchema } from "@shared";
import { format } from "date-fns";
import { Calendar as CalendarIcon, Clock, Info } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { DateRange } from "react-day-picker";
import { CartesianGrid, Line, LineChart, XAxis, YAxis } from "recharts";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  type ChartConfig,
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
  useCostSavingsStatistics,
  useModelStatistics,
  useProfileStatistics,
  useTeamStatistics,
} from "@/lib/statistics.query";

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

const TIMEFRAME_STORAGE_KEY = "cost-statistics-timeframe";

export default function StatisticsPage() {
  const router = useRouter();
  const searchParams = useSearchParams();

  const [timeframe, setTimeframe] = useState<StatisticsTimeFrame>("1h");
  const [dateRange, setDateRange] = useState<DateRange | undefined>();
  const [fromTime, setFromTime] = useState("00:00");
  const [toTime, setToTime] = useState("23:59");
  const [isCustomDialogOpen, setIsCustomDialogOpen] = useState(false);

  // Statistics data fetching hooks
  const currentTimeframe = timeframe.startsWith("custom:") ? "all" : timeframe;
  const { data: teamStatistics = [] } = useTeamStatistics({
    timeframe: currentTimeframe,
  });
  const { data: agentStatistics = [] } = useProfileStatistics({
    timeframe: currentTimeframe,
  });
  const { data: modelStatistics = [] } = useModelStatistics({
    timeframe: currentTimeframe,
  });
  const { data: costSavingsData } = useCostSavingsStatistics({
    timeframe: currentTimeframe,
  });

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
    } else {
      setTimeframe("1h");
    }
  }, [searchParams]);

  // Update URL when timeframe changes
  const updateURL = useCallback(
    (newTimeframe?: string) => {
      const params = new URLSearchParams(searchParams);

      if (newTimeframe !== undefined) {
        params.set("timeframe", newTimeframe);
      }

      router.push(`/cost/statistics?${params.toString()}`, { scroll: false });
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
    if (!dateRange?.from || !dateRange?.to) {
      return;
    }

    const fromDateTime = new Date(dateRange.from);
    const toDateTime = new Date(dateRange.to);

    const [fromHours, fromMinutes] = fromTime.split(":").map(Number);
    fromDateTime.setHours(fromHours, fromMinutes, 0, 0);

    const [toHours, toMinutes] = toTime.split(":").map(Number);
    toDateTime.setHours(toHours, toMinutes, 59, 999);

    const customValue =
      `custom:${fromDateTime.toISOString()}_${toDateTime.toISOString()}` as const;
    handleTimeframeChange(customValue);
    setIsCustomDialogOpen(false);
  }, [dateRange, fromTime, toTime, handleTimeframeChange]);

  const getTimeframeDisplay = useCallback((tf: StatisticsTimeFrame) => {
    if (tf.startsWith("custom:")) {
      const value = tf.replace("custom:", "");
      const [fromDate, toDate] = value.split("_");
      const fromDateTime = new Date(fromDate);
      const toDateTime = new Date(toDate);

      const hasCustomTime =
        fromDateTime.getHours() !== 0 ||
        fromDateTime.getMinutes() !== 0 ||
        toDateTime.getHours() !== 23 ||
        toDateTime.getMinutes() !== 59;

      if (hasCustomTime) {
        return `${format(fromDateTime, "MMM d, HH:mm")} - ${format(toDateTime, "MMM d, HH:mm")}`;
      } else {
        return `${format(fromDateTime, "MMM d")} - ${format(toDateTime, "MMM d")}`;
      }
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

  // Format timestamp for display based on timeframe
  const formatTimestamp = useCallback(
    (timestamp: string) => {
      const date = new Date(timestamp);
      if (timeframe === "1h" || timeframe === "24h") {
        return format(date, "HH:mm");
      }
      return format(date, "MMM d");
    },
    [timeframe],
  );

  // Convert team statistics to recharts format
  const teamChartData = useMemo(() => {
    if (teamStatistics.length === 0) return [];

    const allTimestamps = [
      ...new Set(
        teamStatistics.flatMap((stat) =>
          stat.timeSeries.map((point) => point.timestamp),
        ),
      ),
    ].sort();

    return allTimestamps.map((timestamp) => {
      const dataPoint: Record<string, string | number> = {
        timestamp,
        label: formatTimestamp(timestamp),
      };
      teamStatistics.slice(0, 5).forEach((team) => {
        const point = team.timeSeries.find((p) => p.timestamp === timestamp);
        dataPoint[team.teamId] = point ? point.value : 0;
      });
      return dataPoint;
    });
  }, [teamStatistics, formatTimestamp]);

  const teamChartConfig = useMemo(() => {
    const config: ChartConfig = {};
    teamStatistics.slice(0, 5).forEach((team, index) => {
      config[team.teamId] = {
        label: team.teamName,
        color: `var(--chart-${index + 1})`,
      };
    });
    return config;
  }, [teamStatistics]);

  // Convert profile statistics to recharts format
  const profileChartData = useMemo(() => {
    if (agentStatistics.length === 0) return [];

    const allTimestamps = [
      ...new Set(
        agentStatistics.flatMap((stat) =>
          stat.timeSeries.map((point) => point.timestamp),
        ),
      ),
    ].sort();

    return allTimestamps.map((timestamp) => {
      const dataPoint: Record<string, string | number> = {
        timestamp,
        label: formatTimestamp(timestamp),
      };
      agentStatistics.slice(0, 5).forEach((agent) => {
        const point = agent.timeSeries.find((p) => p.timestamp === timestamp);
        dataPoint[agent.agentId] = point ? point.value : 0;
      });
      return dataPoint;
    });
  }, [agentStatistics, formatTimestamp]);

  const profileChartConfig = useMemo(() => {
    const config: ChartConfig = {};
    agentStatistics.slice(0, 5).forEach((agent, index) => {
      config[agent.agentId] = {
        label: agent.agentName,
        color: `var(--chart-${index + 1})`,
      };
    });
    return config;
  }, [agentStatistics]);

  // Convert model statistics to recharts format
  const modelChartData = useMemo(() => {
    if (modelStatistics.length === 0) return [];

    const allTimestamps = [
      ...new Set(
        modelStatistics.flatMap((stat) =>
          stat.timeSeries.map((point) => point.timestamp),
        ),
      ),
    ].sort();

    return allTimestamps.map((timestamp) => {
      const dataPoint: Record<string, string | number> = {
        timestamp,
        label: formatTimestamp(timestamp),
      };
      modelStatistics.slice(0, 5).forEach((model) => {
        const point = model.timeSeries.find((p) => p.timestamp === timestamp);
        dataPoint[model.model] = point ? point.value : 0;
      });
      return dataPoint;
    });
  }, [modelStatistics, formatTimestamp]);

  const modelChartConfig = useMemo(() => {
    const config: ChartConfig = {};
    modelStatistics.slice(0, 5).forEach((model, index) => {
      config[model.model] = {
        label: model.model,
        color: `var(--chart-${index + 1})`,
      };
    });
    return config;
  }, [modelStatistics]);

  // Cost savings chart data
  const costSavingsChartData = useMemo(() => {
    if (!costSavingsData || costSavingsData.timeSeries.length === 0) return [];

    return costSavingsData.timeSeries.map((point) => ({
      timestamp: point.timestamp,
      label: formatTimestamp(point.timestamp),
      nonOptimized: point.baselineCost,
      actual: point.actualCost,
    }));
  }, [costSavingsData, formatTimestamp]);

  const costSavingsChartConfig: ChartConfig = {
    nonOptimized: {
      label: "Non-Optimized Cost",
      color: "var(--chart-4)",
    },
    actual: {
      label: "Actual Cost",
      color: "var(--chart-2)",
    },
  };

  // Savings breakdown chart data
  const savingsBreakdownChartData = useMemo(() => {
    if (!costSavingsData || costSavingsData.timeSeries.length === 0) return [];

    return costSavingsData.timeSeries.map((point) => ({
      timestamp: point.timestamp,
      label: formatTimestamp(point.timestamp),
      optimization: point.optimizationSavings,
      compression: point.toonSavings,
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
  };

  // Sort statistics by cost for table display
  const sortedTeamStatistics = useMemo(
    () => [...teamStatistics].sort((a, b) => b.cost - a.cost),
    [teamStatistics],
  );
  const sortedAgentStatistics = useMemo(
    () => [...agentStatistics].sort((a, b) => b.cost - a.cost),
    [agentStatistics],
  );
  const sortedModelStatistics = useMemo(
    () => [...modelStatistics].sort((a, b) => b.cost - a.cost),
    [modelStatistics],
  );

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <div className="flex items-center gap-2">
          <a
            href="https://archestra.ai/docs/platform-observability"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            <Info className="h-3 w-3" />
            <span>
              Check open telemetry capabilities to get cost-related insights at
              scale
            </span>
          </a>
        </div>
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

          <Dialog
            open={isCustomDialogOpen}
            onOpenChange={setIsCustomDialogOpen}
          >
            <DialogContent className="sm:max-w-[800px] max-h-[90vh] overflow-y-auto">
              <DialogHeader>
                <DialogTitle>Custom Timeframe</DialogTitle>
                <DialogDescription>
                  Set a custom time period for the statistics view.
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-6 py-4">
                <div className="space-y-3">
                  <Label className="text-sm font-medium">Date Range</Label>
                  <div className="flex justify-center">
                    <Calendar
                      mode="range"
                      defaultMonth={dateRange?.from}
                      selected={dateRange}
                      onSelect={setDateRange}
                      numberOfMonths={2}
                      className="rounded-md border"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label htmlFor="from-time" className="text-sm font-medium">
                      From Time
                    </Label>
                    <Input
                      id="from-time"
                      type="time"
                      value={fromTime}
                      onChange={(e) => setFromTime(e.target.value)}
                      className="w-full"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="to-time" className="text-sm font-medium">
                      To Time
                    </Label>
                    <Input
                      id="to-time"
                      type="time"
                      value={toTime}
                      onChange={(e) => setToTime(e.target.value)}
                      className="w-full"
                    />
                  </div>
                </div>
              </div>
              <DialogFooter className="gap-2">
                <Button
                  variant="outline"
                  onClick={() => setIsCustomDialogOpen(false)}
                >
                  Cancel
                </Button>
                <Button
                  onClick={handleCustomTimeframe}
                  disabled={!dateRange?.from || !dateRange?.to}
                >
                  Apply
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card>
          <CardHeader>
            <CardTitle>Costs</CardTitle>
          </CardHeader>
          <CardContent>
            <ChartContainer
              config={costSavingsChartConfig}
              className="aspect-auto h-80 w-full"
            >
              {costSavingsChartData.length > 0 ? (
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
                </LineChart>
              ) : (
                <div className="flex items-center justify-center h-full text-muted-foreground">
                  No data available
                </div>
              )}
            </ChartContainer>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Cost Savings</CardTitle>
          </CardHeader>
          <CardContent>
            <ChartContainer
              config={savingsBreakdownChartConfig}
              className="aspect-auto h-80 w-full"
            >
              {savingsBreakdownChartData.length > 0 ? (
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
                </LineChart>
              ) : (
                <div className="flex items-center justify-center h-full text-muted-foreground">
                  No data available
                </div>
              )}
            </ChartContainer>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Teams</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
            <div className="order-2 lg:order-1">
              <ChartContainer
                config={teamChartConfig}
                className="aspect-auto h-80 w-full"
              >
                {teamChartData.length > 0 ? (
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
                    {teamStatistics.slice(0, 5).map((team) => (
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
                ) : (
                  <div className="flex items-center justify-center h-full text-muted-foreground">
                    No team data available
                  </div>
                )}
              </ChartContainer>
              {teamStatistics.length > 5 && (
                <p className="text-xs text-muted-foreground text-center mt-2">
                  Chart shows top 5 by cost
                </p>
              )}
            </div>

            <div className="order-1 lg:order-2">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Team Name</TableHead>
                    <TableHead>Members</TableHead>
                    <TableHead>Profiles</TableHead>
                    <TableHead>Requests</TableHead>
                    <TableHead>Tokens</TableHead>
                    <TableHead className="text-right">Cost</TableHead>
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
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Profiles</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
            <div className="order-2 lg:order-1">
              <ChartContainer
                config={profileChartConfig}
                className="aspect-auto h-80 w-full"
              >
                {profileChartData.length > 0 ? (
                  <LineChart
                    accessibilityLayer
                    data={profileChartData}
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
                    {agentStatistics.slice(0, 5).map((agent) => (
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
                ) : (
                  <div className="flex items-center justify-center h-full text-muted-foreground">
                    No profile data available
                  </div>
                )}
              </ChartContainer>
              {agentStatistics.length > 5 && (
                <p className="text-xs text-muted-foreground text-center mt-2">
                  Chart shows top 5 by cost
                </p>
              )}
            </div>

            <div className="order-1 lg:order-2">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Profile Name</TableHead>
                    <TableHead>Team</TableHead>
                    <TableHead>Requests</TableHead>
                    <TableHead>Tokens</TableHead>
                    <TableHead className="text-right">Cost</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {sortedAgentStatistics.length === 0 ? (
                    <TableRow>
                      <TableCell
                        colSpan={5}
                        className="text-center py-8 text-muted-foreground"
                      >
                        No profile data available for the selected timeframe
                      </TableCell>
                    </TableRow>
                  ) : (
                    sortedAgentStatistics.map((profile) => (
                      <TableRow key={profile.agentId}>
                        <TableCell className="font-medium">
                          {profile.agentName}
                        </TableCell>
                        <TableCell>{profile.teamName}</TableCell>
                        <TableCell>
                          {profile.requests.toLocaleString()}
                        </TableCell>
                        <TableCell>
                          {(
                            profile.inputTokens + profile.outputTokens
                          ).toLocaleString()}
                        </TableCell>
                        <TableCell className="text-right">
                          ${profile.cost.toFixed(2)}
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Models</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
            <div className="order-2 lg:order-1">
              <ChartContainer
                config={modelChartConfig}
                className="aspect-auto h-80 w-full"
              >
                {modelChartData.length > 0 ? (
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
                    {modelStatistics.slice(0, 5).map((model) => (
                      <Line
                        key={model.model}
                        dataKey={model.model}
                        type="monotone"
                        stroke={`var(--color-${model.model})`}
                        strokeWidth={2}
                        dot={{
                          strokeWidth: 0,
                          r: 3,
                          fill: `var(--color-${model.model})`,
                        }}
                        activeDot={{ strokeWidth: 0, r: 5 }}
                      />
                    ))}
                  </LineChart>
                ) : (
                  <div className="flex items-center justify-center h-full text-muted-foreground">
                    No model data available
                  </div>
                )}
              </ChartContainer>
              {modelStatistics.length > 5 && (
                <p className="text-xs text-muted-foreground text-center mt-2">
                  Chart shows top 5 by cost
                </p>
              )}
            </div>

            <div className="order-1 lg:order-2">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Model</TableHead>
                    <TableHead>Requests</TableHead>
                    <TableHead>Tokens Used</TableHead>
                    <TableHead>Cost</TableHead>
                    <TableHead className="text-right">% of Total</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {sortedModelStatistics.length === 0 ? (
                    <TableRow>
                      <TableCell
                        colSpan={5}
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
                        <TableCell>${model.cost.toFixed(2)}</TableCell>
                        <TableCell className="text-right">
                          {model.percentage.toFixed(1)}%
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
