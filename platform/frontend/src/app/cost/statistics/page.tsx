"use client";

import {
  CategoryScale,
  Chart as ChartJS,
  Filler,
  Legend,
  LinearScale,
  LineElement,
  PointElement,
  Title,
  Tooltip,
  type TooltipItem,
} from "chart.js";
import { format } from "date-fns";
import { Calendar as CalendarIcon, Clock, Info } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Line } from "react-chartjs-2";
import type { DateRange } from "react-day-picker";

ChartJS.register(
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Title,
  Tooltip,
  Legend,
  Filler,
);

import type { archestraApiTypes } from "@shared";
import { type StatisticsTimeFrame, StatisticsTimeFrameSchema } from "@shared";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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

// Type aliases for better readability
type TeamStatisticsData =
  archestraApiTypes.GetTeamStatisticsResponses["200"][number];
type ProfileStatisticsData =
  archestraApiTypes.GetAgentStatisticsResponses["200"][number];
type ModelStatisticsData =
  archestraApiTypes.GetModelStatisticsResponses["200"][number];
type StatisticsData =
  | TeamStatisticsData
  | ProfileStatisticsData
  | ModelStatisticsData;

// Type guards
function isTeamStatistics(data: StatisticsData): data is TeamStatisticsData {
  return "teamName" in data;
}

function isProfileStatistics(
  data: StatisticsData,
): data is ProfileStatisticsData {
  return "agentName" in data;
}

function isModelStatistics(data: StatisticsData): data is ModelStatisticsData {
  return "model" in data && "percentage" in data;
}

const colors = [
  "#3b82f6", // blue
  "#10b981", // green
  "#f59e0b", // amber
  "#ef4444", // red
  "#8b5cf6", // violet
];

type ChartInstance = {
  data: {
    datasets: unknown[];
  };
  isDatasetVisible: (index: number) => boolean;
};

type ChartEventArgs = {
  event: {
    type: string;
  };
};

function createVisibilitySyncPlugin<T>(
  id: string,
  data: T[],
  getKey: (item: T) => string,
  setHidden: React.Dispatch<React.SetStateAction<Set<string>>>,
) {
  return {
    id,
    afterEvent: (chart: ChartInstance, args: ChartEventArgs) => {
      if (args.event.type === "click") {
        setTimeout(() => {
          const newHidden = new Set<string>();
          chart.data.datasets.forEach((_, index: number) => {
            if (!chart.isDatasetVisible(index)) {
              const item = data[index];
              if (item) {
                newHidden.add(getKey(item));
              }
            }
          });
          setHidden(newHidden);
        }, 10);
      }
    },
  };
}

export default function StatisticsPage() {
  const router = useRouter();
  const searchParams = useSearchParams();

  const [timeframe, setTimeframe] = useState<StatisticsTimeFrame>("1h");
  const [dateRange, setDateRange] = useState<DateRange | undefined>();
  const [fromTime, setFromTime] = useState("00:00");
  const [toTime, setToTime] = useState("23:59");
  const [isCustomDialogOpen, setIsCustomDialogOpen] = useState(false);

  // Track hidden items for each category
  const [hiddenTeams, setHiddenTeams] = useState<Set<string>>(new Set());
  const [hiddenProfiles, setHiddenProfiles] = useState<Set<string>>(new Set());
  const [hiddenModels, setHiddenModels] = useState<Set<string>>(new Set());

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
   * Initialize from URL parameters
   *
   * NOTE: may need to do validation here.. could use StatisticsTimeFrameSchema
   */
  useEffect(() => {
    const { success, data } = StatisticsTimeFrameSchema.safeParse(
      searchParams.get("timeframe"),
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

    // Set time for from date
    const [fromHours, fromMinutes] = fromTime.split(":").map(Number);
    fromDateTime.setHours(fromHours, fromMinutes, 0, 0);

    // Set time for to date
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

      // Check if times are different from default (00:00 to 23:59)
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

  // Helper function to convert statistics to chart format
  const convertStatsToChartData = useCallback(
    <T extends StatisticsData>(
      statistics: T[],
      labelKey:
        | keyof Pick<TeamStatisticsData, "teamName">
        | keyof Pick<ProfileStatisticsData, "agentName">
        | keyof Pick<ModelStatisticsData, "model">,
      colors: string[],
      hiddenIds: Set<string>,
      getKey: (stat: T) => string,
    ) => {
      // Get unique time points across all datasets
      const allTimestamps = [
        ...new Set(
          statistics.flatMap((stat) =>
            stat.timeSeries.map((point) => point.timestamp),
          ),
        ),
      ].sort();

      const datasets = statistics.slice(0, 5).map((stat, index) => {
        // Limit to top 5 for readability
        const data = allTimestamps.map((timestamp) => {
          const point = stat.timeSeries.find((p) => p.timestamp === timestamp);
          return point ? point.value : 0;
        });

        let label: string;
        if (labelKey === "teamName" && isTeamStatistics(stat)) {
          label = stat.teamName;
        } else if (labelKey === "agentName" && isProfileStatistics(stat)) {
          label = stat.agentName;
        } else if (labelKey === "model" && isModelStatistics(stat)) {
          label = stat.model;
        } else {
          label = "Unknown";
        }

        return {
          label,
          data,
          borderColor: colors[index % colors.length],
          backgroundColor: colors[index % colors.length]
            .replace(")", ", 0.1)")
            .replace("rgb", "rgba"),
          borderWidth: 3,
          fill: false,
          tension: 0.4,
          pointBackgroundColor: colors[index % colors.length],
          pointBorderColor: "#ffffff",
          pointBorderWidth: 2,
          pointRadius: 5,
          pointHoverRadius: 8,
          hidden: hiddenIds.has(getKey(stat)),
        };
      });

      // Format timestamps for display
      const labels = allTimestamps.map((timestamp) => {
        const date = new Date(timestamp);
        if (timeframe === "1h") {
          return format(date, "HH:mm");
        } else if (timeframe === "24h") {
          return format(date, "HH:mm");
        } else if (timeframe === "7d" || timeframe === "30d") {
          return format(date, "MMM d");
        } else {
          return format(date, "MMM d");
        }
      });

      return { labels, datasets };
    },
    [timeframe],
  );

  // Filter statistics based on hidden items (for table only)
  const visibleTeamStatistics = teamStatistics.filter(
    (team) => !hiddenTeams.has(team.teamId),
  );
  const visibleProfileStatistics = agentStatistics.filter(
    (agent) => !hiddenProfiles.has(agent.agentId),
  );
  const visibleModelStatistics = modelStatistics.filter(
    (model) => !hiddenModels.has(model.model),
  );

  // Chart.js data configuration - use ALL statistics, let Chart.js handle visibility
  const teamChartData =
    teamStatistics.length > 0
      ? convertStatsToChartData<TeamStatisticsData>(
          teamStatistics,
          "teamName",
          colors,
          hiddenTeams,
          (stat) => stat.teamId,
        )
      : {
          labels: ["No Data"],
          datasets: [
            {
              label: "No teams found",
              data: [0],
              borderColor: "#9ca3af",
              backgroundColor: "rgba(156, 163, 175, 0.1)",
              borderWidth: 3,
              fill: false,
              tension: 0.4,
            },
          ],
        };

  const agentChartData =
    agentStatistics.length > 0
      ? convertStatsToChartData<ProfileStatisticsData>(
          agentStatistics,
          "agentName",
          colors,
          hiddenProfiles,
          (stat) => stat.agentId,
        )
      : {
          labels: ["No Data"],
          datasets: [
            {
              label: "No profiles found",
              data: [0],
              borderColor: "#9ca3af",
              backgroundColor: "rgba(156, 163, 175, 0.1)",
              borderWidth: 3,
              fill: false,
              tension: 0.4,
            },
          ],
        };

  const modelChartData =
    modelStatistics.length > 0
      ? convertStatsToChartData<ModelStatisticsData>(
          modelStatistics,
          "model",
          colors,
          hiddenModels,
          (stat) => stat.model,
        )
      : {
          labels: ["No Data"],
          datasets: [
            {
              label: "No models found",
              data: [0],
              borderColor: "#9ca3af",
              backgroundColor: "rgba(156, 163, 175, 0.1)",
              borderWidth: 3,
              fill: false,
              tension: 0.4,
            },
          ],
        };

  // Chart keys to force remount when data changes
  const teamChartKey = `team-${timeframe}-${teamStatistics.length}-${hiddenTeams.size}`;
  const agentChartKey = `agent-${timeframe}-${agentStatistics.length}-${hiddenProfiles.size}`;
  const modelChartKey = `model-${timeframe}-${modelStatistics.length}-${hiddenModels.size}`;

  // Chart options with default legend behavior (strikethrough on click)
  const chartOptions = useMemo(
    () => ({
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          display: true,
          position: "top" as const,
          align: "end" as const,
          labels: {
            usePointStyle: true,
            pointStyle: "circle",
            padding: 20,
            font: {
              size: 12,
              weight: "normal" as const,
            },
            color: "#64748b",
          },
        },
        tooltip: {
          backgroundColor: "#ffffff",
          titleColor: "#1f2937",
          bodyColor: "#374151",
          borderColor: "#e5e7eb",
          borderWidth: 1,
          cornerRadius: 12,
          padding: 16,
          displayColors: true,
          titleFont: {
            size: 14,
            weight: "bold" as const,
          },
          bodyFont: {
            size: 13,
            weight: "normal" as const,
          },
          boxShadow:
            "0 10px 15px -3px rgba(0, 0, 0, 0.1), 0 4px 6px -2px rgba(0, 0, 0, 0.05)",
          callbacks: {
            label: (context: TooltipItem<"line">) =>
              `${context.dataset.label}: $${context.parsed.y?.toFixed(2) || "0"}`,
            title: (context: TooltipItem<"line">[]) =>
              `Time: ${context[0].label}`,
          },
        },
      },
      scales: {
        x: {
          grid: {
            color: "rgba(148, 163, 184, 0.2)",
            drawBorder: false,
            lineWidth: 1,
          },
          ticks: {
            color: "#64748b",
            font: {
              size: 12,
              weight: "normal" as const,
            },
            padding: 10,
          },
          border: {
            display: false,
          },
        },
        y: {
          grid: {
            color: "rgba(148, 163, 184, 0.2)",
            drawBorder: false,
            lineWidth: 1,
          },
          ticks: {
            color: "#64748b",
            font: {
              size: 12,
              weight: "normal" as const,
            },
            padding: 10,
            callback: (value: string | number) => `$${value}`,
          },
          border: {
            display: false,
          },
          beginAtZero: true,
        },
      },
      elements: {
        point: {
          hoverRadius: 8,
        },
      },
      interaction: {
        intersect: false,
        mode: "index" as const,
      },
    }),
    [],
  );

  // Custom plugins to sync legend visibility with table
  const teamChartPlugin = useMemo(
    () =>
      createVisibilitySyncPlugin(
        "teamVisibilitySync",
        teamStatistics,
        (team) => team.teamId,
        setHiddenTeams,
      ),
    [teamStatistics],
  );

  const agentChartPlugin = useMemo(
    () =>
      createVisibilitySyncPlugin(
        "agentVisibilitySync",
        agentStatistics,
        (agent) => agent.agentId,
        setHiddenProfiles,
      ),
    [agentStatistics],
  );

  const modelChartPlugin = useMemo(
    () =>
      createVisibilitySyncPlugin(
        "modelVisibilitySync",
        modelStatistics,
        (model) => model.model,
        setHiddenModels,
      ),
    [modelStatistics],
  );

  // Cost savings chart data (baseline vs actual)
  const costSavingsChartData = useMemo(() => {
    if (!costSavingsData || costSavingsData.timeSeries.length === 0) {
      return {
        labels: ["No Data"],
        datasets: [
          {
            label: "No data available",
            data: [0],
            borderColor: "#9ca3af",
            backgroundColor: "rgba(156, 163, 175, 0.1)",
            borderWidth: 3,
            fill: false,
            tension: 0.4,
          },
        ],
      };
    }

    const labels = costSavingsData.timeSeries.map((point) => {
      const date = new Date(point.timestamp);
      if (timeframe === "1h") {
        return format(date, "HH:mm");
      } else if (timeframe === "24h") {
        return format(date, "HH:mm");
      } else if (timeframe === "7d" || timeframe === "30d") {
        return format(date, "MMM d");
      } else {
        return format(date, "MMM d");
      }
    });

    return {
      labels,
      datasets: [
        {
          label: "Non-Optimized Cost",
          data: costSavingsData.timeSeries.map((point) => point.baselineCost),
          borderColor: "#ef4444", // red
          backgroundColor: "rgba(239, 68, 68, 0.1)",
          borderWidth: 3,
          fill: false,
          tension: 0.4,
          pointBackgroundColor: "#ef4444",
          pointBorderColor: "#ffffff",
          pointBorderWidth: 2,
          pointRadius: 5,
          pointHoverRadius: 8,
        },
        {
          label: "Actual Cost",
          data: costSavingsData.timeSeries.map((point) => point.actualCost),
          borderColor: "#10b981", // green
          backgroundColor: "rgba(16, 185, 129, 0.1)",
          borderWidth: 3,
          fill: false,
          tension: 0.4,
          pointBackgroundColor: "#10b981",
          pointBorderColor: "#ffffff",
          pointBorderWidth: 2,
          pointRadius: 5,
          pointHoverRadius: 8,
        },
      ],
    };
  }, [costSavingsData, timeframe]);

  // Savings breakdown chart data (optimization rules vs TOON)
  const savingsBreakdownChartData = useMemo(() => {
    if (!costSavingsData || costSavingsData.timeSeries.length === 0) {
      return {
        labels: ["No Data"],
        datasets: [
          {
            label: "No data available",
            data: [0],
            borderColor: "#9ca3af",
            backgroundColor: "rgba(156, 163, 175, 0.1)",
            borderWidth: 3,
            fill: false,
            tension: 0.4,
          },
        ],
      };
    }

    const labels = costSavingsData.timeSeries.map((point) => {
      const date = new Date(point.timestamp);
      if (timeframe === "1h") {
        return format(date, "HH:mm");
      } else if (timeframe === "24h") {
        return format(date, "HH:mm");
      } else if (timeframe === "7d" || timeframe === "30d") {
        return format(date, "MMM d");
      } else {
        return format(date, "MMM d");
      }
    });

    return {
      labels,
      datasets: [
        {
          label: "Optimization Rules Savings",
          data: costSavingsData.timeSeries.map(
            (point) => point.optimizationSavings,
          ),
          borderColor: "#3b82f6", // blue
          backgroundColor: "rgba(59, 130, 246, 0.1)",
          borderWidth: 3,
          fill: false,
          tension: 0.4,
          pointBackgroundColor: "#3b82f6",
          pointBorderColor: "#ffffff",
          pointBorderWidth: 2,
          pointRadius: 5,
          pointHoverRadius: 8,
        },
        {
          label: "Tool Compression Savings",
          data: costSavingsData.timeSeries.map((point) => point.toonSavings),
          borderColor: "#8b5cf6", // purple
          backgroundColor: "rgba(139, 92, 246, 0.1)",
          borderWidth: 3,
          fill: false,
          tension: 0.4,
          pointBackgroundColor: "#8b5cf6",
          pointBorderColor: "#ffffff",
          pointBorderWidth: 2,
          pointRadius: 5,
          pointHoverRadius: 8,
        },
      ],
    };
  }, [costSavingsData, timeframe]);

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
            <div className="h-80">
              <Line
                key={`cost-savings-${timeframe}`}
                data={costSavingsChartData}
                options={chartOptions}
              />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Cost Savings</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="h-80">
              <Line
                key={`savings-breakdown-${timeframe}`}
                data={savingsBreakdownChartData}
                options={chartOptions}
              />
            </div>
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
              <div className="h-80">
                <Line
                  key={teamChartKey}
                  data={teamChartData}
                  options={chartOptions}
                  plugins={[teamChartPlugin]}
                />
              </div>
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
                  {visibleTeamStatistics.length === 0 ? (
                    <TableRow>
                      <TableCell
                        colSpan={6}
                        className="text-center py-8 text-muted-foreground"
                      >
                        No team data available for the selected timeframe
                      </TableCell>
                    </TableRow>
                  ) : (
                    visibleTeamStatistics.map((team) => (
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
              <div className="h-80">
                <Line
                  key={agentChartKey}
                  data={agentChartData}
                  options={chartOptions}
                  plugins={[agentChartPlugin]}
                />
              </div>
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
                  {visibleProfileStatistics.length === 0 ? (
                    <TableRow>
                      <TableCell
                        colSpan={5}
                        className="text-center py-8 text-muted-foreground"
                      >
                        No profile data available for the selected timeframe
                      </TableCell>
                    </TableRow>
                  ) : (
                    visibleProfileStatistics.map((profile) => (
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
              <div className="h-80">
                <Line
                  key={modelChartKey}
                  data={modelChartData}
                  options={chartOptions}
                  plugins={[modelChartPlugin]}
                />
              </div>
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
                  {visibleModelStatistics.length === 0 ? (
                    <TableRow>
                      <TableCell
                        colSpan={5}
                        className="text-center py-8 text-muted-foreground"
                      >
                        No model data available for the selected timeframe
                      </TableCell>
                    </TableRow>
                  ) : (
                    visibleModelStatistics.map((model) => (
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
