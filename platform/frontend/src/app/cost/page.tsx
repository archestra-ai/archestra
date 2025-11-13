"use client";

// Type definitions
interface TokenPriceData {
  id?: string;
  model: string;
  pricePerMillionInput: string;
  pricePerMillionOutput: string;
  createdAt?: string;
  updatedAt?: string;
}

interface LimitData {
  id?: string;
  entityType: "agent" | "organization" | "team";
  entityId: string;
  limitType: "tool_calls" | "token_cost" | "mcp_server_calls";
  limitValue: number;
  mcpServerName?: string | null;
  toolName?: string | null;
  model?: string | null;
  name?: string;
  description?: string;
  currentUsageTokensIn?: number;
  currentUsageTokensOut?: number;
  maxTokensPerHour?: number;
  maxTokensPerDay?: number;
  maxTokensPerMonth?: number;
  maxCostPerHour?: number;
  maxCostPerDay?: number;
  maxCostPerMonth?: number;
  createdAt?: string;
  updatedAt?: string;
}

interface TeamData {
  id: string;
  name: string;
  // Add other team properties as needed
}

// Loading skeleton component
function LoadingSkeleton({ count, prefix }: { count: number; prefix: string }) {
  const skeletons = Array.from(
    { length: count },
    (_, i) => `${prefix}-skeleton-${i}`,
  );

  return (
    <div className="space-y-3">
      {skeletons.map((key) => (
        <div key={key} className="h-16 bg-muted animate-pulse rounded" />
      ))}
    </div>
  );
}

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
import {
  Calendar as CalendarIcon,
  Clock,
  Edit,
  Info,
  Plus,
  Save,
  Settings,
  Trash2,
  X,
} from "lucide-react";
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

import type { archestraApiTypes } from "@shared";
import { OptimizationRulesTab } from "@/app/cost/optimization-rules-tab";
import type { CatalogItem } from "@/app/mcp-catalog/_parts/mcp-server-card";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
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
import { Progress } from "@/components/ui/progress";
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
import { TooltipProvider } from "@/components/ui/tooltip";
import { useAgents, useDefaultAgent } from "@/lib/agent.query";
import { useInternalMcpCatalog } from "@/lib/internal-mcp-catalog.query";
import {
  useCreateLimit,
  useDeleteLimit,
  useLimits,
  useUpdateLimit,
} from "@/lib/limits.query";
import { useOptimizationRules } from "@/lib/optimization-rule.query";
import {
  useOrganization,
  useUpdateOrganization,
} from "@/lib/organization.query";
import {
  type TimeFrame,
  useAgentStatistics,
  useModelStatistics,
  useTeamStatistics,
} from "@/lib/statistics.query";
import { useTeams } from "@/lib/team.query";
import {
  useCreateTokenPrice,
  useDeleteTokenPrice,
  useTokenPrices,
  useUpdateTokenPrice,
} from "@/lib/token-price.query";

// Inline Form Component for adding/editing token prices
function TokenPriceInlineForm({
  initialData,
  onSave,
  onCancel,
}: {
  initialData?: TokenPriceData;
  onSave: (data: TokenPriceData) => void;
  onCancel: () => void;
}) {
  const [formData, setFormData] = useState({
    model: initialData?.model || "",
    pricePerMillionInput: String(initialData?.pricePerMillionInput || ""),
    pricePerMillionOutput: String(initialData?.pricePerMillionOutput || ""),
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSave(formData);
  };

  const isValid =
    formData.model &&
    formData.pricePerMillionInput &&
    formData.pricePerMillionOutput;

  return (
    <tr className="border-b">
      <td colSpan={4} className="p-4 bg-muted/30">
        <form
          onSubmit={handleSubmit}
          className="flex flex-wrap items-center gap-4"
        >
          <div className="flex items-center gap-2">
            <Label htmlFor="model" className="text-sm whitespace-nowrap">
              Model
            </Label>
            <Input
              id="model"
              type="text"
              value={formData.model}
              onChange={(e) =>
                setFormData({ ...formData, model: e.target.value })
              }
              placeholder="e.g. gpt-4"
              required
              className="w-48"
            />
          </div>

          <div className="flex items-center gap-2">
            <Label htmlFor="priceInput" className="text-sm whitespace-nowrap">
              Input Price ($)
            </Label>
            <Input
              id="priceInput"
              type="number"
              step="0.01"
              min="0"
              value={formData.pricePerMillionInput}
              onChange={(e) =>
                setFormData({
                  ...formData,
                  pricePerMillionInput: e.target.value,
                })
              }
              placeholder="50.00"
              required
              className="w-32"
            />
          </div>

          <div className="flex items-center gap-2">
            <Label htmlFor="priceOutput" className="text-sm whitespace-nowrap">
              Output Price ($)
            </Label>
            <Input
              id="priceOutput"
              type="number"
              step="0.01"
              min="0"
              value={formData.pricePerMillionOutput}
              onChange={(e) =>
                setFormData({
                  ...formData,
                  pricePerMillionOutput: e.target.value,
                })
              }
              placeholder="50.00"
              required
              className="w-32"
            />
          </div>

          <div className="flex gap-2 flex-shrink-0">
            <Button type="submit" disabled={!isValid} size="sm">
              <Save className="h-4 w-4 mr-1" />
              Save
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={onCancel}
              size="sm"
            >
              <X className="h-4 w-4 mr-1" />
              Cancel
            </Button>
          </div>
        </form>
      </td>
    </tr>
  );
}

// Token Price Row Component for displaying/editing individual token prices
function TokenPriceRow({
  tokenPrice,
  isEditing,
  onEdit,
  onSave,
  onCancel,
  onDelete,
}: {
  tokenPrice: TokenPriceData;
  isEditing: boolean;
  onEdit: () => void;
  onSave: (data: TokenPriceData) => void;
  onCancel: () => void;
  onDelete: () => void;
}) {
  if (isEditing) {
    return (
      <TokenPriceInlineForm
        initialData={tokenPrice}
        onSave={onSave}
        onCancel={onCancel}
      />
    );
  }

  return (
    <tr className="border-b hover:bg-muted/30">
      <td className="p-4 font-medium">{tokenPrice.model}</td>
      <td className="p-4">
        ${parseFloat(tokenPrice.pricePerMillionInput).toFixed(2)}
      </td>
      <td className="p-4">
        ${parseFloat(tokenPrice.pricePerMillionOutput).toFixed(2)}
      </td>
      <td className="p-4">
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={onEdit}>
            <Edit className="h-4 w-4" />
          </Button>
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="text-destructive hover:text-destructive"
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Delete Token Price</AlertDialogTitle>
                <AlertDialogDescription>
                  Are you sure you want to delete the pricing for{" "}
                  {tokenPrice.model}? This action cannot be undone.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  onClick={onDelete}
                  className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                >
                  Delete
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </td>
    </tr>
  );
}

// Inline Form Component for adding/editing limits
function LimitInlineForm({
  initialData,
  limitType,
  onSave,
  onCancel,
  teams,
  mcpServers,
  tokenPrices,
  hasOrganizationLimit,
  getTeamsWithLimits,
}: {
  initialData?: LimitData;
  limitType: "token_cost" | "mcp_server_calls";
  onSave: (data: LimitData) => void;
  onCancel: () => void;
  teams: TeamData[];
  mcpServers: CatalogItem[];
  tokenPrices: TokenPriceData[];
  hasOrganizationLimit: (
    limitType: "token_cost" | "mcp_server_calls",
    mcpServerName?: string,
  ) => boolean;
  getTeamsWithLimits: (
    limitType: "token_cost" | "mcp_server_calls",
    mcpServerName?: string,
  ) => string[];
}) {
  const [formData, setFormData] = useState({
    name: initialData?.name || "",
    description: initialData?.description || "",
    entityType: initialData?.entityType || "team",
    entityId: initialData?.entityId || "",
    mcpServerName: initialData?.mcpServerName || "",
    limitValue: initialData?.limitValue?.toString() || "",
    model: initialData?.model || "",
  });

  // Get teams with existing limits for this limit type and MCP server
  const teamsWithLimits = getTeamsWithLimits(limitType, formData.mcpServerName);
  const organizationHasLimit = hasOrganizationLimit(
    limitType,
    formData.mcpServerName,
  );

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSave({
      ...formData,
      limitType,
      limitValue: parseInt(formData.limitValue, 10),
      entityId:
        formData.entityType === "organization" ? "org" : formData.entityId,
    });
  };

  const isValid =
    formData.limitValue &&
    (formData.entityType === "organization" || formData.entityId) &&
    (limitType === "token_cost" ? formData.model : formData.mcpServerName);

  return (
    <tr className="border-b">
      <td
        colSpan={limitType === "token_cost" ? 4 : 5}
        className="p-4 bg-muted/30"
      >
        <TooltipProvider>
          <form
            onSubmit={handleSubmit}
            className="flex flex-wrap items-center gap-4"
          >
            <div className="flex items-center gap-2">
              <Label htmlFor="entityType" className="text-sm whitespace-nowrap">
                Apply To
              </Label>
              <Select
                value={formData.entityType}
                onValueChange={(value) =>
                  setFormData({
                    ...formData,
                    entityType: value as "agent" | "organization" | "team",
                    entityId: "",
                  })
                }
              >
                <SelectTrigger className="w-48">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="team">Team</SelectItem>
                  <SelectItem
                    value="organization"
                    disabled={organizationHasLimit}
                  >
                    The whole organization
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>

            {formData.entityType === "team" && (
              <div className="flex items-center gap-2">
                <Label htmlFor="team" className="text-sm whitespace-nowrap">
                  Team
                </Label>
                <Select
                  value={formData.entityId}
                  onValueChange={(value) =>
                    setFormData({ ...formData, entityId: value })
                  }
                >
                  <SelectTrigger className="w-48">
                    <SelectValue placeholder="Select a team" />
                  </SelectTrigger>
                  <SelectContent>
                    {teams.length === 0 ? (
                      <div className="px-2 py-1.5 text-sm text-muted-foreground">
                        No teams available
                      </div>
                    ) : (
                      teams.map((team) => (
                        <SelectItem
                          key={team.id}
                          value={team.id}
                          disabled={teamsWithLimits.includes(team.id)}
                        >
                          {team.name}
                        </SelectItem>
                      ))
                    )}
                  </SelectContent>
                </Select>
              </div>
            )}

            {limitType !== "token_cost" && (
              <div className="flex items-center gap-2">
                <Label
                  htmlFor="mcpServer"
                  className="text-sm whitespace-nowrap"
                >
                  MCP Server
                </Label>
                <Select
                  value={formData.mcpServerName}
                  onValueChange={(value) =>
                    setFormData({
                      ...formData,
                      mcpServerName: value,
                    })
                  }
                >
                  <SelectTrigger className="w-48">
                    <SelectValue placeholder="Select an MCP server" />
                  </SelectTrigger>
                  <SelectContent>
                    {mcpServers.length === 0 ? (
                      <div className="px-2 py-1.5 text-sm text-muted-foreground">
                        No MCP servers available
                      </div>
                    ) : (
                      mcpServers.map((server) => {
                        // For MCP limits, check if this server already has a limit for the selected entity
                        const isDisabled =
                          limitType === "mcp_server_calls" &&
                          ((formData.entityType === "organization" &&
                            hasOrganizationLimit(limitType, server.name)) ||
                            (formData.entityType === "team" &&
                              formData.entityId &&
                              formData.entityId.trim() !== "" &&
                              getTeamsWithLimits(
                                limitType,
                                server.name,
                              ).includes(formData.entityId)));

                        return (
                          <SelectItem
                            key={server.id}
                            value={server.name}
                            disabled={Boolean(isDisabled)}
                          >
                            {server.name}
                          </SelectItem>
                        );
                      })
                    )}
                  </SelectContent>
                </Select>
              </div>
            )}

            {limitType === "token_cost" && (
              <div className="flex items-center gap-2">
                <Label htmlFor="model" className="text-sm whitespace-nowrap">
                  Model
                </Label>
                <Select
                  value={formData.model || ""}
                  onValueChange={(value) =>
                    setFormData((prev) => ({ ...prev, model: value }))
                  }
                >
                  <SelectTrigger className="flex-1">
                    <SelectValue placeholder="Select model" />
                  </SelectTrigger>
                  <SelectContent>
                    {tokenPrices?.map((price) => (
                      <SelectItem key={price.model} value={price.model}>
                        {price.model}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            <div className="flex items-center gap-2">
              <Label htmlFor="limitValue" className="text-sm whitespace-nowrap">
                Limit Value ({limitType === "token_cost" ? "cost $" : "calls"})
              </Label>
              <Input
                id="limitValue"
                type="text"
                value={
                  formData.limitValue
                    ? parseInt(formData.limitValue, 10).toLocaleString()
                    : ""
                }
                onChange={(e) => {
                  // Remove commas and keep only numbers
                  const value = e.target.value.replace(/[^0-9]/g, "");
                  setFormData({ ...formData, limitValue: value });
                }}
                placeholder={
                  limitType === "token_cost" ? "e.g. 100,000" : "e.g. 10,000"
                }
                min="1"
                required
                className="w-32"
              />
            </div>

            <div className="flex gap-2 flex-shrink-0">
              <Button type="submit" disabled={!isValid} size="sm">
                <Save className="h-4 w-4 mr-1" />
                Save
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={onCancel}
                size="sm"
              >
                <X className="h-4 w-4 mr-1" />
                Cancel
              </Button>
            </div>
          </form>
        </TooltipProvider>
      </td>
    </tr>
  );
}

// Limit Row Component for displaying/editing individual limits
function LimitRow({
  limit,
  isEditing,
  onEdit,
  onSave,
  onCancel,
  onDelete,
  teams,
  mcpServers,
  tokenPrices,
  getEntityName,
  getUsageStatus,
  hasOrganizationLimit,
  getTeamsWithLimits,
}: {
  limit: LimitData;
  isEditing: boolean;
  onEdit: () => void;
  onSave: (data: LimitData) => void;
  onCancel: () => void;
  onDelete: () => void;
  teams: TeamData[];
  mcpServers: CatalogItem[];
  tokenPrices: TokenPriceData[];
  getEntityName: (limit: LimitData) => string;
  getUsageStatus: (
    currentUsageTokensIn: number,
    currentUsageTokensOut: number,
    limitValue: number,
    limitType: string,
  ) => {
    percentage: number;
    status: string;
    actualUsage: number;
    actualLimit: number;
  };
  hasOrganizationLimit: (
    limitType: "token_cost" | "mcp_server_calls",
    mcpServerName?: string,
  ) => boolean;
  getTeamsWithLimits: (
    limitType: "token_cost" | "mcp_server_calls",
    mcpServerName?: string,
  ) => string[];
}) {
  if (isEditing) {
    return (
      <LimitInlineForm
        initialData={limit}
        limitType={limit.limitType as "token_cost" | "mcp_server_calls"}
        onSave={onSave}
        onCancel={onCancel}
        teams={teams}
        mcpServers={mcpServers}
        tokenPrices={tokenPrices}
        hasOrganizationLimit={hasOrganizationLimit}
        getTeamsWithLimits={getTeamsWithLimits}
      />
    );
  }

  const { percentage, status, actualUsage, actualLimit } = getUsageStatus(
    limit.currentUsageTokensIn || 0,
    limit.currentUsageTokensOut || 0,
    limit.limitValue,
    limit.limitType,
  );

  return (
    <tr className="border-b hover:bg-muted/30">
      <td className="p-4">
        <div className="flex items-center gap-2">
          <Badge
            variant={
              status === "danger"
                ? "destructive"
                : status === "warning"
                  ? "secondary"
                  : "default"
            }
          >
            {status === "danger"
              ? "Exceeded"
              : status === "warning"
                ? "Near Limit"
                : "Safe"}
          </Badge>
        </div>
      </td>
      <td className="p-4 text-sm text-muted-foreground">
        {getEntityName(limit)}
      </td>
      {limit.limitType !== "token_cost" && (
        <td className="p-4 text-sm text-muted-foreground">
          {limit.mcpServerName || "-"}
        </td>
      )}
      <td className="p-4">
        <div className="space-y-1">
          <div className="flex justify-between text-sm">
            <span>
              {limit.limitType === "token_cost"
                ? `$${actualUsage.toFixed(2)} / $${actualLimit.toFixed(2)}`
                : `${(limit.currentUsageTokensIn || 0).toLocaleString()} / ${limit.limitValue.toLocaleString()} calls`}
            </span>
            <span>{percentage.toFixed(1)}%</span>
          </div>
          <Progress
            value={Math.min(percentage, 100)}
            className={`h-2 ${
              status === "danger"
                ? "bg-red-100"
                : status === "warning"
                  ? "bg-orange-100"
                  : ""
            }`}
          />
        </div>
      </td>
      <td className="p-4">
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={onEdit}>
            <Edit className="h-4 w-4" />
          </Button>
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="text-destructive hover:text-destructive"
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Delete Limit</AlertDialogTitle>
                <AlertDialogDescription>
                  Are you sure you want to delete this limit? This action cannot
                  be undone.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  onClick={onDelete}
                  className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                >
                  Delete
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </td>
    </tr>
  );
}

export default function CostPage() {
  const router = useRouter();
  const searchParams = useSearchParams();

  const [activeTab, setActiveTab] = useState("statistics");
  const [timeframe, setTimeframe] = useState("1h");
  const [dateRange, setDateRange] = useState<DateRange | undefined>();
  const [fromTime, setFromTime] = useState("00:00");
  const [toTime, setToTime] = useState("23:59");
  const [isCustomDialogOpen, setIsCustomDialogOpen] = useState(false);
  const [editingLimitId, setEditingLimitId] = useState<string | null>(null);
  const [isAddingLlmLimit, setIsAddingLlmLimit] = useState(false);
  const [isAddingMcpLimit, setIsAddingMcpLimit] = useState(false);
  const [editingTokenPriceId, setEditingTokenPriceId] = useState<string | null>(
    null,
  );
  const [isAddingTokenPrice, setIsAddingTokenPrice] = useState(false);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);

  // Data fetching hooks
  const { data: limits = [], isLoading: limitsLoading } = useLimits();
  const { data: mcpServers = [] } = useInternalMcpCatalog();
  const { data: teams = [] } = useTeams();
  const { data: organizationDetails } = useOrganization();
  const { data: tokenPrices = [], isLoading: tokenPricesLoading } =
    useTokenPrices();
  const { data: agents = [] } = useAgents();
  const { data: defaultAgent } = useDefaultAgent();
  const { data: optimizationRules = [], isLoading: optimizationRulesLoading } =
    useOptimizationRules(selectedAgentId);

  // Set default agent as selected when it loads
  useEffect(() => {
    if (defaultAgent && !selectedAgentId) {
      setSelectedAgentId(defaultAgent.id);
    }
  }, [defaultAgent, selectedAgentId]);

  // Statistics data fetching hooks
  const currentTimeframe = timeframe.startsWith("custom:")
    ? "all"
    : (timeframe as TimeFrame);
  const { data: teamStatistics = [] } = useTeamStatistics({
    timeframe: currentTimeframe,
  });
  const { data: agentStatistics = [] } = useAgentStatistics({
    timeframe: currentTimeframe,
  });
  const { data: modelStatistics = [] } = useModelStatistics({
    timeframe: currentTimeframe,
  });
  const updateCleanupInterval = useUpdateOrganization(
    "Cleanup interval updated successfully",
    "Failed to update cleanup interval",
  );
  const deleteLimit = useDeleteLimit();
  const createLimit = useCreateLimit();
  const updateLimit = useUpdateLimit();
  const deleteTokenPrice = useDeleteTokenPrice();
  const createTokenPrice = useCreateTokenPrice();
  const updateTokenPrice = useUpdateTokenPrice();

  // Filter limits by type
  const llmLimits = limits.filter((limit) => limit.limitType === "token_cost");
  const mcpLimits = limits.filter(
    (limit) => limit.limitType === "mcp_server_calls",
  );

  // Helper functions to detect existing limits
  const hasOrganizationLimit = (
    limitType: "token_cost" | "mcp_server_calls",
    mcpServerName?: string,
  ) => {
    return limits.some((limit) => {
      if (
        limit.limitType !== limitType ||
        limit.entityType !== "organization"
      ) {
        return false;
      }
      // For LLM limits, any org limit blocks another
      if (limitType === "token_cost") {
        return true;
      }
      // For MCP limits, only block if same MCP server
      return limit.mcpServerName === mcpServerName;
    });
  };

  const getTeamsWithLimits = (
    limitType: "token_cost" | "mcp_server_calls",
    mcpServerName?: string,
  ) => {
    return limits
      .filter((limit) => {
        if (limit.limitType !== limitType || limit.entityType !== "team") {
          return false;
        }
        // For LLM limits, any team limit blocks another
        if (limitType === "token_cost") {
          return true;
        }
        // For MCP limits, only block if same MCP server
        return limit.mcpServerName === mcpServerName;
      })
      .map((limit) => limit.entityId);
  };

  // Helper function to get entity name
  const getEntityName = (limit: LimitData) => {
    if (limit.entityType === "team") {
      const team = teams.find((t) => t.id === limit.entityId);
      return team?.name || "Unknown Team";
    }
    if (limit.entityType === "organization") {
      return "The whole organization";
    }
    return "Unknown Agent";
  };

  // Helper function to calculate real cost for token limits
  const calculateTokenCost = (
    inputTokens: number,
    outputTokens: number,
  ): number => {
    // For token cost limits, we need to calculate cost from tokens
    // Since we don't have a specific model in the limit, we'll use average prices
    // This is a simplified calculation - in a real scenario you might want to track model-specific usage
    if (tokenPrices.length === 0) {
      // This should not happen since the backend ensures pricing exists,
      // but if it does, return 0 to avoid errors
      console.warn("No token prices available for cost calculation");
      return 0;
    }

    const averageInputPrice =
      tokenPrices.reduce(
        (sum, tp) => sum + parseFloat(tp.pricePerMillionInput),
        0,
      ) / tokenPrices.length;

    const averageOutputPrice =
      tokenPrices.reduce(
        (sum, tp) => sum + parseFloat(tp.pricePerMillionOutput),
        0,
      ) / tokenPrices.length;

    const inputCost = (inputTokens * averageInputPrice) / 1000000;
    const outputCost = (outputTokens * averageOutputPrice) / 1000000;
    const totalCost = inputCost + outputCost;

    return totalCost;
  };

  // Helper function to get usage percentage and status
  const getUsageStatus = (
    currentUsageTokensIn: number,
    currentUsageTokensOut: number,
    limitValue: number,
    limitType: string,
  ) => {
    let actualUsage: number;
    const actualLimit = limitValue;

    // For token cost limits, convert tokens to dollars using separate input/output tokens
    // limitValue is already in dollars, so no conversion needed
    if (limitType === "token_cost") {
      actualUsage = calculateTokenCost(
        currentUsageTokensIn,
        currentUsageTokensOut,
      );
    } else {
      // For MCP server calls, use the input tokens field as call count
      actualUsage = currentUsageTokensIn;
    }

    const percentage = (actualUsage / actualLimit) * 100;
    let status: "safe" | "warning" | "danger" = "safe";

    if (percentage >= 90) status = "danger";
    else if (percentage >= 75) status = "warning";

    return { percentage, status, actualUsage, actualLimit };
  };

  const handleDeleteLimit = async (id: string) => {
    await deleteLimit.mutateAsync({ id });
  };

  const handleCreateLimit = async (data: LimitData) => {
    try {
      await createLimit.mutateAsync(data);
      setIsAddingLlmLimit(false);
      setIsAddingMcpLimit(false);
    } catch (error) {
      console.error("Failed to create limit:", error);
    }
  };

  const handleUpdateLimit = async (id: string, data: LimitData) => {
    try {
      await updateLimit.mutateAsync({ id, ...data });
      setEditingLimitId(null);
    } catch (error) {
      console.error("Failed to update limit:", error);
    }
  };

  const handleCancelEdit = () => {
    setEditingLimitId(null);
    setIsAddingLlmLimit(false);
    setIsAddingMcpLimit(false);
    setEditingTokenPriceId(null);
    setIsAddingTokenPrice(false);
  };

  const handleDeleteTokenPrice = async (id: string) => {
    await deleteTokenPrice.mutateAsync({ id });
  };

  const handleCreateTokenPrice = async (data: TokenPriceData) => {
    try {
      await createTokenPrice.mutateAsync(data);
      setIsAddingTokenPrice(false);
    } catch (error) {
      console.error("Failed to create token price:", error);
    }
  };

  const handleUpdateTokenPrice = async (id: string, data: TokenPriceData) => {
    try {
      await updateTokenPrice.mutateAsync({ id, ...data });
      setEditingTokenPriceId(null);
    } catch (error) {
      console.error("Failed to update token price:", error);
    }
  };

  // Initialize from URL parameters
  useEffect(() => {
    const tab = searchParams.get("tab");
    const tf = searchParams.get("timeframe");

    if (
      tab &&
      ["statistics", "limits", "token-price", "optimization-rules"].includes(
        tab,
      )
    ) {
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

  // Helper function to convert statistics to chart format
  const convertStatsToChartData = (
    statistics: Array<{
      teamName?: string;
      agentName?: string;
      model?: string;
      timeSeries: Array<{ timestamp: string; value: number }>;
    }>,
    labelKey: "teamName" | "agentName" | "model",
    colors: string[],
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

      return {
        label: stat[labelKey] || "Unknown",
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
  };

  const colors = [
    "#3b82f6", // blue
    "#10b981", // green
    "#f59e0b", // amber
    "#ef4444", // red
    "#8b5cf6", // violet
  ];

  // Chart.js data configuration with teams as separate lines
  const teamChartData =
    teamStatistics.length > 0
      ? convertStatsToChartData(teamStatistics, "teamName", colors)
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

  // Agent chart data
  const agentChartData =
    agentStatistics.length > 0
      ? convertStatsToChartData(agentStatistics, "agentName", colors)
      : {
          labels: ["No Data"],
          datasets: [
            {
              label: "No agents found",
              data: [0],
              borderColor: "#9ca3af",
              backgroundColor: "rgba(156, 163, 175, 0.1)",
              borderWidth: 3,
              fill: false,
              tension: 0.4,
            },
          ],
        };

  // Model chart data
  const modelChartData =
    modelStatistics.length > 0
      ? convertStatsToChartData(modelStatistics, "model", colors)
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
          <h1 className="text-2xl font-semibold tracking-tight mb-2">
            Cost & Limits
          </h1>
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
            <TabsTrigger value="optimization-rules">
              Optimization Rules
            </TabsTrigger>
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

            <Card>
              <CardHeader>
                <CardTitle>Teams</CardTitle>
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
                        {teamStatistics.length === 0 ? (
                          <TableRow>
                            <TableCell
                              colSpan={6}
                              className="text-center py-8 text-muted-foreground"
                            >
                              No team data available for the selected timeframe
                            </TableCell>
                          </TableRow>
                        ) : (
                          teamStatistics.map((team) => (
                            <TableRow key={team.teamId}>
                              <TableCell className="font-medium">
                                {team.teamName}
                              </TableCell>
                              <TableCell>{team.members}</TableCell>
                              <TableCell>{team.agents}</TableCell>
                              <TableCell>
                                {team.requests.toLocaleString()}
                              </TableCell>
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
                <CardTitle>Agents</CardTitle>
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
                        {agentStatistics.length === 0 ? (
                          <TableRow>
                            <TableCell
                              colSpan={5}
                              className="text-center py-8 text-muted-foreground"
                            >
                              No agent data available for the selected timeframe
                            </TableCell>
                          </TableRow>
                        ) : (
                          agentStatistics.map((agent) => (
                            <TableRow key={agent.agentId}>
                              <TableCell className="font-medium">
                                {agent.agentName}
                              </TableCell>
                              <TableCell>{agent.teamName}</TableCell>
                              <TableCell>
                                {agent.requests.toLocaleString()}
                              </TableCell>
                              <TableCell>
                                {(
                                  agent.inputTokens + agent.outputTokens
                                ).toLocaleString()}
                              </TableCell>
                              <TableCell className="text-right">
                                ${agent.cost.toFixed(2)}
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
                        {modelStatistics.length === 0 ? (
                          <TableRow>
                            <TableCell
                              colSpan={5}
                              className="text-center py-8 text-muted-foreground"
                            >
                              No model data available for the selected timeframe
                            </TableCell>
                          </TableRow>
                        ) : (
                          modelStatistics.map((model) => (
                            <TableRow key={model.model}>
                              <TableCell className="font-medium">
                                {model.model}
                              </TableCell>
                              <TableCell>
                                {model.requests.toLocaleString()}
                              </TableCell>
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
          </TabsContent>

          <TabsContent value="limits" className="mt-0 space-y-6">
            {/* Global Cleanup Settings Panel */}
            <Card>
              <CardHeader>
                <div className="flex items-center justify-between">
                  <CardTitle className="text-lg">
                    Auto-cleanup interval
                  </CardTitle>
                  <Select
                    value={organizationDetails?.limitCleanupInterval || "1h"}
                    onValueChange={(value) => {
                      updateCleanupInterval.mutate({
                        limitCleanupInterval: value as NonNullable<
                          archestraApiTypes.UpdateOrganizationData["body"]
                        >["limitCleanupInterval"],
                      });
                    }}
                    disabled={updateCleanupInterval.isPending}
                  >
                    <SelectTrigger className="w-48">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="1h">Every hour</SelectItem>
                      <SelectItem value="12h">Every 12 hours</SelectItem>
                      <SelectItem value="24h">Every 24 hours</SelectItem>
                      <SelectItem value="1w">Every week</SelectItem>
                      <SelectItem value="1m">Every month</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </CardHeader>
            </Card>

            {/* LLM Limits Section */}
            <Card>
              <CardHeader>
                <div className="flex items-center justify-between">
                  <div>
                    <CardTitle className="text-xl">LLM Limits</CardTitle>
                    <CardDescription>
                      Token cost limits for LLM usage across teams and
                      organization
                    </CardDescription>
                  </div>
                  <Button
                    onClick={() => setIsAddingLlmLimit(true)}
                    size="sm"
                    disabled={isAddingLlmLimit || editingLimitId !== null}
                  >
                    <Plus className="h-4 w-4 mr-1" />
                    Add LLM Limit
                  </Button>
                </div>
              </CardHeader>
              <CardContent>
                {limitsLoading ? (
                  <LoadingSkeleton count={3} prefix="llm-limits" />
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Status</TableHead>
                        <TableHead>Applied to</TableHead>
                        <TableHead>Usage</TableHead>
                        <TableHead>Actions</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {isAddingLlmLimit && (
                        <LimitInlineForm
                          limitType="token_cost"
                          onSave={handleCreateLimit}
                          onCancel={handleCancelEdit}
                          teams={teams}
                          mcpServers={mcpServers}
                          tokenPrices={tokenPrices}
                          hasOrganizationLimit={hasOrganizationLimit}
                          getTeamsWithLimits={getTeamsWithLimits}
                        />
                      )}
                      {llmLimits.length === 0 && !isAddingLlmLimit ? (
                        <TableRow>
                          <TableCell
                            colSpan={4}
                            className="text-center py-8 text-muted-foreground"
                          >
                            <Settings className="h-8 w-8 mx-auto mb-2 opacity-50" />
                            <p>No LLM limits configured</p>
                            <p className="text-sm">
                              Click "Add LLM Limit" to get started
                            </p>
                          </TableCell>
                        </TableRow>
                      ) : (
                        llmLimits.map((limit) => (
                          <LimitRow
                            key={limit.id}
                            limit={limit}
                            isEditing={editingLimitId === limit.id}
                            onEdit={() => setEditingLimitId(limit.id)}
                            onSave={(data) => handleUpdateLimit(limit.id, data)}
                            onCancel={handleCancelEdit}
                            onDelete={() => handleDeleteLimit(limit.id)}
                            teams={teams}
                            mcpServers={mcpServers}
                            tokenPrices={tokenPrices}
                            getEntityName={getEntityName}
                            getUsageStatus={getUsageStatus}
                            hasOrganizationLimit={hasOrganizationLimit}
                            getTeamsWithLimits={getTeamsWithLimits}
                          />
                        ))
                      )}
                    </TableBody>
                  </Table>
                )}
              </CardContent>
            </Card>

            {/* MCP Limits Section */}
            <Card className="relative">
              <CardHeader>
                <div className="flex items-center justify-between">
                  <div>
                    <CardTitle className="text-xl">MCP Limits</CardTitle>
                    <CardDescription>
                      MCP server and tool call limits across teams and
                      organization
                    </CardDescription>
                  </div>
                  <Button
                    onClick={() => setIsAddingMcpLimit(true)}
                    size="sm"
                    disabled={true}
                  >
                    <Plus className="h-4 w-4 mr-1" />
                    Add MCP Limit
                  </Button>
                </div>
              </CardHeader>
              <CardContent className="relative">
                {/* Coming Soon Overlay */}
                <div className="absolute inset-0 bg-background/80 backdrop-blur-sm rounded-lg flex items-center justify-center z-10">
                  <div className="text-center">
                    <p className="text-lg font-semibold text-muted-foreground">
                      Coming soon
                    </p>
                  </div>
                </div>

                {/* Disabled Content */}
                <div className="opacity-30 pointer-events-none">
                  {limitsLoading ? (
                    <LoadingSkeleton count={3} prefix="mcp-limits" />
                  ) : (
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Status</TableHead>
                          <TableHead>Applied to</TableHead>
                          <TableHead>MCP Server</TableHead>
                          <TableHead>Usage</TableHead>
                          <TableHead>Actions</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {isAddingMcpLimit && (
                          <LimitInlineForm
                            limitType="mcp_server_calls"
                            onSave={handleCreateLimit}
                            onCancel={handleCancelEdit}
                            teams={teams}
                            mcpServers={mcpServers}
                            tokenPrices={tokenPrices}
                            hasOrganizationLimit={hasOrganizationLimit}
                            getTeamsWithLimits={getTeamsWithLimits}
                          />
                        )}
                        {mcpLimits.length === 0 && !isAddingMcpLimit ? (
                          <TableRow>
                            <TableCell
                              colSpan={5}
                              className="text-center py-8 text-muted-foreground"
                            >
                              <Settings className="h-8 w-8 mx-auto mb-2 opacity-50" />
                              <p>No MCP limits configured</p>
                              <p className="text-sm">
                                Click "Add MCP Limit" to get started
                              </p>
                            </TableCell>
                          </TableRow>
                        ) : (
                          mcpLimits.map((limit) => (
                            <LimitRow
                              key={limit.id}
                              limit={limit}
                              isEditing={editingLimitId === limit.id}
                              onEdit={() => setEditingLimitId(limit.id)}
                              onSave={(data) =>
                                handleUpdateLimit(limit.id, data)
                              }
                              onCancel={handleCancelEdit}
                              onDelete={() => handleDeleteLimit(limit.id)}
                              teams={teams}
                              mcpServers={mcpServers}
                              tokenPrices={tokenPrices}
                              getEntityName={getEntityName}
                              getUsageStatus={getUsageStatus}
                              hasOrganizationLimit={hasOrganizationLimit}
                              getTeamsWithLimits={getTeamsWithLimits}
                            />
                          ))
                        )}
                      </TableBody>
                    </Table>
                  )}
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="token-price" className="mt-0">
            <Card>
              <CardHeader>
                <div className="flex items-center justify-between">
                  <div>
                    <CardTitle>Token Pricing</CardTitle>
                    <CardDescription>
                      Configure token pricing for different models (per million
                      tokens)
                    </CardDescription>
                  </div>
                  <Button
                    onClick={() => setIsAddingTokenPrice(true)}
                    size="sm"
                    disabled={
                      isAddingTokenPrice || editingTokenPriceId !== null
                    }
                  >
                    <Plus className="h-4 w-4 mr-1" />
                    Add Model Price
                  </Button>
                </div>
              </CardHeader>
              <CardContent>
                {tokenPricesLoading ? (
                  <LoadingSkeleton count={3} prefix="token-prices" />
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Model</TableHead>
                        <TableHead>Input Price ($)</TableHead>
                        <TableHead>Output Price ($)</TableHead>
                        <TableHead>Actions</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {isAddingTokenPrice && (
                        <TokenPriceInlineForm
                          onSave={handleCreateTokenPrice}
                          onCancel={handleCancelEdit}
                        />
                      )}
                      {tokenPrices.length === 0 && !isAddingTokenPrice ? (
                        <TableRow>
                          <TableCell
                            colSpan={4}
                            className="text-center py-8 text-muted-foreground"
                          >
                            <Settings className="h-8 w-8 mx-auto mb-2 opacity-50" />
                            <p>No token prices configured</p>
                            <p className="text-sm">
                              Click "Add Model Price" to get started
                            </p>
                          </TableCell>
                        </TableRow>
                      ) : (
                        tokenPrices.map((tokenPrice) => (
                          <TokenPriceRow
                            key={tokenPrice.id}
                            tokenPrice={tokenPrice}
                            isEditing={editingTokenPriceId === tokenPrice.id}
                            onEdit={() => setEditingTokenPriceId(tokenPrice.id)}
                            onSave={(data) =>
                              handleUpdateTokenPrice(tokenPrice.id, data)
                            }
                            onCancel={handleCancelEdit}
                            onDelete={() =>
                              handleDeleteTokenPrice(tokenPrice.id)
                            }
                          />
                        ))
                      )}
                    </TableBody>
                  </Table>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          <OptimizationRulesTab
            selectedAgentId={selectedAgentId}
            setSelectedAgentId={setSelectedAgentId}
            agents={agents}
            optimizationRules={optimizationRules}
            optimizationRulesLoading={optimizationRulesLoading}
          />
        </Tabs>
      </div>
    </div>
  );
}
