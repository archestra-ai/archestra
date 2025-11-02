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
import { useEffect, useState } from "react";
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

import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

export default function CostPage() {
  const router = useRouter();
  const searchParams = useSearchParams();

  const [activeTab, setActiveTab] = useState("statistics");
  const [timeframe, setTimeframe] = useState("1h");
  const [dateRange, setDateRange] = useState<DateRange | undefined>();
  const [fromTime, setFromTime] = useState("00:00");
  const [toTime, setToTime] = useState("23:59");
  const [isCustomDialogOpen, setIsCustomDialogOpen] = useState(false);

  // Initialize from URL parameters
  useEffect(() => {
    const tab = searchParams.get("tab");
    const tf = searchParams.get("timeframe");

    if (tab && ["statistics", "limits", "token-price"].includes(tab)) {
      setActiveTab(tab);
    }

    if (tf) {
      setTimeframe(tf);
    }
  }, [searchParams]);

  // Update URL when tab or timeframe changes
  const updateURL = (newTab?: string, newTimeframe?: string) => {
    const params = new URLSearchParams(searchParams);

    if (newTab !== undefined) {
      params.set("tab", newTab);
    }

    if (newTimeframe !== undefined) {
      params.set("timeframe", newTimeframe);
    }

    router.push(`/cost?${params.toString()}`, { scroll: false });
  };

  const handleTabChange = (tab: string) => {
    setActiveTab(tab);
    updateURL(tab, undefined);
  };

  const handleTimeframeChange = (tf: string) => {
    setTimeframe(tf);
    updateURL(undefined, tf);
  };

  const handleCustomTimeframe = () => {
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

    const customValue = `custom:${fromDateTime.toISOString()}_${toDateTime.toISOString()}`;
    handleTimeframeChange(customValue);
    setIsCustomDialogOpen(false);
  };

  const getTimeframeDisplay = (tf: string) => {
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
  };

  // Chart.js data configuration with teams as separate lines
  const teamChartData = {
    labels: ["00:00", "04:00", "08:00", "12:00", "16:00", "20:00", "24:00"],
    datasets: [
      {
        label: "Engineering",
        data: [15.67, 23.45, 42.12, 67.89, 89.45, 112.34, 123.67],
        borderColor: "#3b82f6",
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
        label: "Support",
        data: [8.92, 15.34, 28.67, 45.23, 59.78, 71.23, 78.95],
        borderColor: "#10b981",
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
      {
        label: "Marketing",
        data: [5.23, 8.67, 15.45, 23.89, 28.34, 32.67, 34.89],
        borderColor: "#f59e0b",
        backgroundColor: "rgba(245, 158, 11, 0.1)",
        borderWidth: 3,
        fill: false,
        tension: 0.4,
        pointBackgroundColor: "#f59e0b",
        pointBorderColor: "#ffffff",
        pointBorderWidth: 2,
        pointRadius: 5,
        pointHoverRadius: 8,
      },
      {
        label: "Sales",
        data: [3.45, 6.78, 12.34, 18.9, 22.45, 25.67, 28.12],
        borderColor: "#ef4444",
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
        label: "Operations",
        data: [2.12, 4.23, 7.89, 12.45, 15.67, 18.23, 19.89],
        borderColor: "#8b5cf6",
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

  // Agent chart data
  const agentChartData = {
    labels: ["00:00", "04:00", "08:00", "12:00", "16:00", "20:00", "24:00"],
    datasets: [
      {
        label: "Data Analysis Agent",
        data: [8.45, 12.78, 23.56, 34.67, 45.89, 52.34, 58.9],
        borderColor: "#3b82f6",
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
        label: "Customer Support Bot",
        data: [6.23, 11.45, 19.87, 29.84, 38.76, 44.12, 48.67],
        borderColor: "#10b981",
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
      {
        label: "Code Review Assistant",
        data: [4.12, 7.89, 14.56, 22.34, 28.9, 33.45, 36.78],
        borderColor: "#f59e0b",
        backgroundColor: "rgba(245, 158, 11, 0.1)",
        borderWidth: 3,
        fill: false,
        tension: 0.4,
        pointBackgroundColor: "#f59e0b",
        pointBorderColor: "#ffffff",
        pointBorderWidth: 2,
        pointRadius: 5,
        pointHoverRadius: 8,
      },
      {
        label: "Marketing Content Gen",
        data: [2.89, 5.34, 9.78, 15.67, 19.45, 22.89, 25.12],
        borderColor: "#ef4444",
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
    ],
  };

  // Model chart data
  const modelChartData = {
    labels: ["00:00", "04:00", "08:00", "12:00", "16:00", "20:00", "24:00"],
    datasets: [
      {
        label: "GPT-4 Turbo",
        data: [18.45, 27.89, 49.67, 76.34, 98.76, 115.23, 125.89],
        borderColor: "#3b82f6",
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
        label: "Claude 3 Opus",
        data: [14.23, 21.56, 38.9, 59.78, 77.45, 89.12, 96.34],
        borderColor: "#10b981",
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
      {
        label: "GPT-3.5 Turbo",
        data: [5.67, 8.9, 15.34, 23.78, 30.45, 35.67, 38.9],
        borderColor: "#f59e0b",
        backgroundColor: "rgba(245, 158, 11, 0.1)",
        borderWidth: 3,
        fill: false,
        tension: 0.4,
        pointBackgroundColor: "#f59e0b",
        pointBorderColor: "#ffffff",
        pointBorderWidth: 2,
        pointRadius: 5,
        pointHoverRadius: 8,
      },
      {
        label: "Gemini Pro",
        data: [3.45, 5.78, 10.23, 15.9, 20.34, 23.89, 26.12],
        borderColor: "#ef4444",
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
        label: "Claude 3 Haiku",
        data: [1.89, 3.12, 5.67, 8.45, 10.78, 12.34, 13.56],
        borderColor: "#8b5cf6",
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

  const chartOptions = {
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
        displayColors: false,
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
            `Cost: $${context.parsed.y?.toFixed(2) || "0"}`,
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
  };

  return (
    <div className="w-full h-full">
      <div className="border-b border-border bg-card/30">
        <div className="max-w-7xl mx-auto px-8 py-8">
          <h1 className="text-2xl font-semibold tracking-tight mb-2">Cost</h1>
          <p className="text-sm text-muted-foreground">
            Monitor and manage your AI model usage costs across all agents and
            teams.
          </p>
        </div>
      </div>

      <div className="max-w-7xl mx-auto px-8 py-6">
        <Tabs
          value={activeTab}
          onValueChange={handleTabChange}
          className="w-full"
        >
          <TabsList className="mb-4">
            <TabsTrigger value="statistics">Statistics</TabsTrigger>
            <TabsTrigger value="limits">Limits</TabsTrigger>
            <TabsTrigger value="token-price">Token Price</TabsTrigger>
          </TabsList>

          <TabsContent value="statistics" className="mt-0 space-y-6">
            <div className="flex justify-between items-center">
              <div className="flex items-center gap-2">
                <a
                  href="https://www.archestra.ai/docs/platform-observability"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
                >
                  <Info className="h-3 w-3" />
                  <span>
                    Check open telemetry capabilities to get cost-related
                    insights at scale
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
                      handleTimeframeChange(value);
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
                        <Label className="text-sm font-medium">
                          Date Range
                        </Label>
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
                          <Label
                            htmlFor="from-time"
                            className="text-sm font-medium"
                          >
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
                          <Label
                            htmlFor="to-time"
                            className="text-sm font-medium"
                          >
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

            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
              <Card>
                <CardHeader>
                  <CardTitle>Total Tokens</CardTitle>
                  <CardDescription>
                    {timeframe === "all"
                      ? "All-time"
                      : timeframe.startsWith("custom:")
                        ? `Last ${getTimeframeDisplay(timeframe)}`
                        : `Last ${getTimeframeDisplay(timeframe)}`}
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold">1,234,567</div>
                  <p className="text-xs text-muted-foreground">
                    +12.3% from previous period
                  </p>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle>Total Cost</CardTitle>
                  <CardDescription>
                    {timeframe === "all"
                      ? "All-time"
                      : timeframe.startsWith("custom:")
                        ? `Last ${getTimeframeDisplay(timeframe)}`
                        : `Last ${getTimeframeDisplay(timeframe)}`}
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold">$2,456.89</div>
                  <p className="text-xs text-muted-foreground">
                    +8.7% from previous period
                  </p>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle>Avg Cost/Request</CardTitle>
                  <CardDescription>
                    {timeframe === "all"
                      ? "All-time average"
                      : timeframe.startsWith("custom:")
                        ? `Last ${getTimeframeDisplay(timeframe)}`
                        : `Last ${getTimeframeDisplay(timeframe)}`}
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold">$0.045</div>
                  <p className="text-xs text-muted-foreground">
                    -2.1% from previous period
                  </p>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle>Active Models</CardTitle>
                  <CardDescription>
                    {timeframe === "all"
                      ? "All-time"
                      : timeframe.startsWith("custom:")
                        ? `Last ${getTimeframeDisplay(timeframe)}`
                        : `Last ${getTimeframeDisplay(timeframe)}`}
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold">7</div>
                  <p className="text-xs text-muted-foreground">
                    GPT-4, Claude, Gemini...
                  </p>
                </CardContent>
              </Card>
            </div>

            <Card>
              <CardHeader>
                <CardTitle>Usage by Team</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
                  {/* Chart on the left */}
                  <div className="order-2 lg:order-1">
                    <div className="h-80">
                      <Line data={teamChartData} options={chartOptions} />
                    </div>
                  </div>

                  {/* Table on the right */}
                  <div className="order-1 lg:order-2">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Team Name</TableHead>
                          <TableHead>Members</TableHead>
                          <TableHead>Agents</TableHead>
                          <TableHead>Requests</TableHead>
                          <TableHead>Tokens</TableHead>
                          <TableHead className="text-right">Cost</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        <TableRow>
                          <TableCell className="font-medium">
                            Engineering
                          </TableCell>
                          <TableCell>12</TableCell>
                          <TableCell>8</TableCell>
                          <TableCell>15,234</TableCell>
                          <TableCell>1,234,567</TableCell>
                          <TableCell className="text-right">
                            $1,567.89
                          </TableCell>
                        </TableRow>
                        <TableRow>
                          <TableCell className="font-medium">Support</TableCell>
                          <TableCell>6</TableCell>
                          <TableCell>4</TableCell>
                          <TableCell>9,876</TableCell>
                          <TableCell>567,890</TableCell>
                          <TableCell className="text-right">$789.45</TableCell>
                        </TableRow>
                        <TableRow>
                          <TableCell className="font-medium">
                            Marketing
                          </TableCell>
                          <TableCell>4</TableCell>
                          <TableCell>3</TableCell>
                          <TableCell>3,456</TableCell>
                          <TableCell>234,567</TableCell>
                          <TableCell className="text-right">$298.67</TableCell>
                        </TableRow>
                        <TableRow>
                          <TableCell className="font-medium">Sales</TableCell>
                          <TableCell>8</TableCell>
                          <TableCell>2</TableCell>
                          <TableCell>1,789</TableCell>
                          <TableCell>123,456</TableCell>
                          <TableCell className="text-right">$156.78</TableCell>
                        </TableRow>
                        <TableRow>
                          <TableCell className="font-medium">
                            Operations
                          </TableCell>
                          <TableCell>3</TableCell>
                          <TableCell>2</TableCell>
                          <TableCell>987</TableCell>
                          <TableCell>67,890</TableCell>
                          <TableCell className="text-right">$89.34</TableCell>
                        </TableRow>
                      </TableBody>
                    </Table>
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Usage by Agent</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
                  {/* Chart on the left */}
                  <div className="order-2 lg:order-1">
                    <div className="h-80">
                      <Line data={agentChartData} options={chartOptions} />
                    </div>
                  </div>

                  {/* Table on the right */}
                  <div className="order-1 lg:order-2">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Agent Name</TableHead>
                          <TableHead>Team</TableHead>
                          <TableHead>Requests</TableHead>
                          <TableHead>Tokens</TableHead>
                          <TableHead className="text-right">Cost</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        <TableRow>
                          <TableCell className="font-medium">
                            Data Analysis Agent
                          </TableCell>
                          <TableCell>Engineering</TableCell>
                          <TableCell>3,456</TableCell>
                          <TableCell>234,567</TableCell>
                          <TableCell className="text-right">$345.67</TableCell>
                        </TableRow>
                        <TableRow>
                          <TableCell className="font-medium">
                            Customer Support Bot
                          </TableCell>
                          <TableCell>Support</TableCell>
                          <TableCell>8,901</TableCell>
                          <TableCell>198,765</TableCell>
                          <TableCell className="text-right">$298.45</TableCell>
                        </TableRow>
                        <TableRow>
                          <TableCell className="font-medium">
                            Code Review Assistant
                          </TableCell>
                          <TableCell>Engineering</TableCell>
                          <TableCell>2,345</TableCell>
                          <TableCell>156,789</TableCell>
                          <TableCell className="text-right">$234.56</TableCell>
                        </TableRow>
                        <TableRow>
                          <TableCell className="font-medium">
                            Marketing Content Gen
                          </TableCell>
                          <TableCell>Marketing</TableCell>
                          <TableCell>1,234</TableCell>
                          <TableCell>98,765</TableCell>
                          <TableCell className="text-right">$123.45</TableCell>
                        </TableRow>
                      </TableBody>
                    </Table>
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Usage by Model</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
                  {/* Chart on the left */}
                  <div className="order-2 lg:order-1">
                    <div className="h-80">
                      <Line data={modelChartData} options={chartOptions} />
                    </div>
                  </div>

                  {/* Table on the right */}
                  <div className="order-1 lg:order-2">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Model</TableHead>
                          <TableHead>Requests</TableHead>
                          <TableHead>Tokens Used</TableHead>
                          <TableHead>Cost</TableHead>
                          <TableHead className="text-right">
                            % of Total
                          </TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        <TableRow>
                          <TableCell className="font-medium">
                            GPT-4 Turbo
                          </TableCell>
                          <TableCell>12,345</TableCell>
                          <TableCell>456,789</TableCell>
                          <TableCell>$1,234.56</TableCell>
                          <TableCell className="text-right">45.2%</TableCell>
                        </TableRow>
                        <TableRow>
                          <TableCell className="font-medium">
                            Claude 3 Opus
                          </TableCell>
                          <TableCell>8,901</TableCell>
                          <TableCell>345,678</TableCell>
                          <TableCell>$890.12</TableCell>
                          <TableCell className="text-right">32.8%</TableCell>
                        </TableRow>
                        <TableRow>
                          <TableCell className="font-medium">
                            GPT-3.5 Turbo
                          </TableCell>
                          <TableCell>23,456</TableCell>
                          <TableCell>234,567</TableCell>
                          <TableCell>$234.56</TableCell>
                          <TableCell className="text-right">12.4%</TableCell>
                        </TableRow>
                        <TableRow>
                          <TableCell className="font-medium">
                            Gemini Pro
                          </TableCell>
                          <TableCell>5,678</TableCell>
                          <TableCell>123,456</TableCell>
                          <TableCell>$98.76</TableCell>
                          <TableCell className="text-right">6.3%</TableCell>
                        </TableRow>
                        <TableRow>
                          <TableCell className="font-medium">
                            Claude 3 Haiku
                          </TableCell>
                          <TableCell>15,432</TableCell>
                          <TableCell>98,765</TableCell>
                          <TableCell>$45.67</TableCell>
                          <TableCell className="text-right">3.3%</TableCell>
                        </TableRow>
                      </TableBody>
                    </Table>
                  </div>
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="limits" className="mt-0">
            <Card>
              <CardHeader>
                <CardTitle>Limits Configuration</CardTitle>
                <CardDescription>Set spending and usage limits</CardDescription>
              </CardHeader>
              <CardContent>
                <p className="text-muted-foreground">Coming soon...</p>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="token-price" className="mt-0">
            <Card>
              <CardHeader>
                <CardTitle>Token Pricing</CardTitle>
                <CardDescription>
                  Configure token pricing for different models
                </CardDescription>
              </CardHeader>
              <CardContent>
                <p className="text-muted-foreground">Coming soon...</p>
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}
