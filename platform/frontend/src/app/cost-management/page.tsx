"use client";

import { AlertCircle, Plus, X } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
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
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  type TokenPrice,
  type UpdateTokenPriceInput,
  useTokenPrices,
  useUpdateTokenPrices,
} from "@/lib/token-pricing.query";

interface TeamBudget {
  id: string;
  teamId: string;
  teamName: string;
  limit: string;
}

interface AgentBudget {
  id: string;
  agentId: string;
  agentName: string;
  limit: string;
}

interface ToolCallLimit {
  id: string;
  level: "org" | "team" | "agent";
  teamId?: string;
  agentId?: string;
  mcpServers: string[];
  tools: string[];
  dailyLimit: string;
  monthlyLimit: string;
}

export default function CostManagementPage() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  // Get the active tab from URL, default to "usage"
  const activeTab = searchParams.get("tab") || "usage";

  const [orgBudgetLimit, setOrgBudgetLimit] = useState("1000");
  const [teamBudgets, setTeamBudgets] = useState<TeamBudget[]>([]);
  const [agentBudgets, setAgentBudgets] = useState<AgentBudget[]>([]);
  const [toolCallLimits, setToolCallLimits] = useState<ToolCallLimit[]>([]);
  const [autoShutdown, setAutoShutdown] = useState(false);
  const [selectedPeriod, setSelectedPeriod] = useState("daily");
  const { data: tokenPrices = [], isLoading: isLoadingPrices } =
    useTokenPrices();
  const updateTokenPricesMutation = useUpdateTokenPrices();
  const [editedPrices, setEditedPrices] = useState<Record<string, TokenPrice>>(
    {},
  );

  const currentSpend = 42.58;
  const budgetAmount = parseFloat(orgBudgetLimit) || 1000;
  const spendPercentage = (currentSpend / budgetAmount) * 100;

  // Function to update URL when tab changes
  const handleTabChange = useCallback(
    (value: string) => {
      const params = new URLSearchParams(searchParams);
      params.set("tab", value);
      router.push(`${pathname}?${params.toString()}`);
    },
    [pathname, router, searchParams],
  );

  const addTeamBudget = () => {
    const newTeamBudget: TeamBudget = {
      id: `team-${Date.now()}`,
      teamId: "",
      teamName: "",
      limit: "",
    };
    setTeamBudgets([...teamBudgets, newTeamBudget]);
  };

  const removeTeamBudget = (id: string) => {
    setTeamBudgets(teamBudgets.filter((tb) => tb.id !== id));
  };

  const updateTeamBudget = (
    id: string,
    field: keyof TeamBudget,
    value: string,
  ) => {
    setTeamBudgets(
      teamBudgets.map((tb) => (tb.id === id ? { ...tb, [field]: value } : tb)),
    );
  };

  const addAgentBudget = () => {
    const newAgentBudget: AgentBudget = {
      id: `agent-${Date.now()}`,
      agentId: "",
      agentName: "",
      limit: "",
    };
    setAgentBudgets([...agentBudgets, newAgentBudget]);
  };

  const removeAgentBudget = (id: string) => {
    setAgentBudgets(agentBudgets.filter((ab) => ab.id !== id));
  };

  const updateAgentBudget = (
    id: string,
    field: keyof AgentBudget,
    value: string,
  ) => {
    setAgentBudgets(
      agentBudgets.map((ab) => (ab.id === id ? { ...ab, [field]: value } : ab)),
    );
  };

  const addToolCallLimit = (level: "org" | "team" | "agent") => {
    const newLimit: ToolCallLimit = {
      id: `limit-${Date.now()}`,
      level,
      mcpServers: [],
      tools: [],
      dailyLimit: "",
      monthlyLimit: "",
    };
    setToolCallLimits([...toolCallLimits, newLimit]);
  };

  const removeToolCallLimit = (id: string) => {
    setToolCallLimits(toolCallLimits.filter((limit) => limit.id !== id));
  };

  const updateToolCallLimit = (id: string, updates: Partial<ToolCallLimit>) => {
    setToolCallLimits(
      toolCallLimits.map((limit) =>
        limit.id === id ? { ...limit, ...updates } : limit,
      ),
    );
  };

  const mockUsageData = {
    teams: [
      { name: "Engineering", cost: 22.15, percentage: 52.0 },
      { name: "Support", cost: 15.23, percentage: 35.8 },
      { name: "Marketing", cost: 5.2, percentage: 12.2 },
    ],
    agents: [
      {
        name: "Customer Support Bot",
        cost: 15.23,
        calls: 1250,
        tokens: 125000,
      },
      { name: "Code Review Assistant", cost: 12.45, calls: 890, tokens: 98500 },
      { name: "Data Analyst", cost: 8.67, calls: 456, tokens: 67800 },
      { name: "Content Generator", cost: 6.23, calls: 234, tokens: 45200 },
    ],
    providers: [
      { name: "OpenAI", cost: 28.45, percentage: 66.8 },
      { name: "Anthropic", cost: 10.23, percentage: 24.0 },
      { name: "Gemini", cost: 3.9, percentage: 9.2 },
    ],
    models: [
      { name: "gpt-4-turbo", cost: 18.23, tokens: 182300, percentage: 42.8 },
      { name: "gpt-3.5-turbo", cost: 10.22, tokens: 511000, percentage: 24.0 },
      { name: "claude-3-opus", cost: 7.45, tokens: 49667, percentage: 17.5 },
      { name: "claude-3-sonnet", cost: 2.78, tokens: 46333, percentage: 6.5 },
      { name: "gemini-1.5-pro", cost: 3.9, tokens: 78000, percentage: 9.2 },
    ],
  };

  return (
    <div className="w-full h-full">
      <div className="border-b border-border bg-card/30">
        <div className="max-w-7xl mx-auto px-8 py-8">
          <h1 className="text-2xl font-semibold tracking-tight mb-2">
            Cost Management
          </h1>
          <p className="text-sm text-muted-foreground">
            Monitor and control your AI agent spending with budget limits and
            usage analytics
          </p>
        </div>
      </div>

      <div className="max-w-7xl mx-auto px-8 py-8">
        <div className="grid gap-6">
          {spendPercentage > 75 && (
            <Alert>
              <AlertCircle className="h-4 w-4" />
              <AlertDescription>
                You've used {spendPercentage.toFixed(1)}% of your budget.
                Consider adjusting your usage or increasing your budget limit.
              </AlertDescription>
            </Alert>
          )}

          <Tabs
            value={activeTab}
            onValueChange={handleTabChange}
            className="w-full"
          >
            <TabsList className="grid w-full grid-cols-4">
              <TabsTrigger value="usage">Usage Breakdown</TabsTrigger>
              <TabsTrigger value="llm-limits">LLM Limits</TabsTrigger>
              <TabsTrigger value="tool-limits">Tool Call Limits</TabsTrigger>
              <TabsTrigger value="token-pricing">Token Pricing</TabsTrigger>
            </TabsList>

            <TabsContent value="usage" className="space-y-4">
              <div className="grid gap-4 md:grid-cols-2">
                <Card>
                  <CardHeader>
                    <CardTitle className="text-base">Cost by Team</CardTitle>
                    <CardDescription>Team spending breakdown</CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    {mockUsageData.teams.map((team) => (
                      <div
                        key={team.name}
                        className="flex items-center justify-between"
                      >
                        <div className="flex-1">
                          <div className="flex items-center justify-between mb-1">
                            <span className="text-sm font-medium">
                              {team.name}
                            </span>
                            <span className="text-sm text-muted-foreground">
                              ${team.cost.toFixed(2)}
                            </span>
                          </div>
                          <div className="flex items-center justify-between">
                            <Progress
                              value={team.percentage}
                              className="flex-1 mr-2"
                            />
                            <span className="text-xs text-muted-foreground">
                              {team.percentage.toFixed(1)}%
                            </span>
                          </div>
                        </div>
                      </div>
                    ))}
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader>
                    <CardTitle className="text-base">Cost by Agent</CardTitle>
                    <CardDescription>Top spending agents today</CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    {mockUsageData.agents.map((agent) => (
                      <div
                        key={agent.name}
                        className="flex items-center justify-between"
                      >
                        <div className="flex-1">
                          <div className="flex items-center justify-between mb-1">
                            <span className="text-sm font-medium">
                              {agent.name}
                            </span>
                            <span className="text-sm text-muted-foreground">
                              ${agent.cost.toFixed(2)}
                            </span>
                          </div>
                          <div className="flex items-center justify-between">
                            <Progress
                              value={(agent.cost / currentSpend) * 100}
                              className="flex-1 mr-2"
                            />
                            <div className="text-xs text-muted-foreground text-right">
                              <div>{agent.calls} calls</div>
                              <div>
                                {(agent.tokens / 1000).toFixed(1)}K tokens
                              </div>
                            </div>
                          </div>
                        </div>
                      </div>
                    ))}
                  </CardContent>
                </Card>
              </div>

              <div className="grid gap-4 md:grid-cols-2">
                <Card>
                  <CardHeader>
                    <CardTitle className="text-base">
                      Cost by Provider
                    </CardTitle>
                    <CardDescription>LLM provider breakdown</CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    {mockUsageData.providers.map((provider) => (
                      <div
                        key={provider.name}
                        className="flex items-center justify-between"
                      >
                        <div className="flex-1">
                          <div className="flex items-center justify-between mb-1">
                            <span className="text-sm font-medium">
                              {provider.name}
                            </span>
                            <span className="text-sm text-muted-foreground">
                              ${provider.cost.toFixed(2)}
                            </span>
                          </div>
                          <div className="flex items-center justify-between">
                            <Progress
                              value={provider.percentage}
                              className="flex-1 mr-2"
                            />
                            <span className="text-xs text-muted-foreground">
                              {provider.percentage.toFixed(1)}%
                            </span>
                          </div>
                        </div>
                      </div>
                    ))}
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader>
                    <CardTitle className="text-base">Cost by Model</CardTitle>
                    <CardDescription>
                      Breakdown by specific AI models
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <div className="grid gap-4 md:grid-cols-2">
                      {mockUsageData.models.map((model) => (
                        <div
                          key={model.name}
                          className="flex items-center justify-between"
                        >
                          <div className="flex-1">
                            <div className="flex items-center justify-between mb-1">
                              <span className="text-sm font-medium">
                                {model.name}
                              </span>
                              <span className="text-sm text-muted-foreground">
                                ${model.cost.toFixed(2)}
                              </span>
                            </div>
                            <div className="flex items-center justify-between">
                              <Progress
                                value={model.percentage}
                                className="flex-1 mr-2"
                              />
                              <div className="text-xs text-muted-foreground text-right">
                                <div>{model.percentage.toFixed(1)}%</div>
                                <div>
                                  {(model.tokens / 1000).toFixed(1)}K tokens
                                </div>
                              </div>
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  </CardContent>
                </Card>
              </div>
            </TabsContent>

            <TabsContent value="llm-limits" className="space-y-4">
              <Card>
                <CardHeader>
                  <CardTitle>LLM Budget Configuration</CardTitle>
                  <CardDescription>
                    Set spending limits at different levels and configure
                    automatic controls
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-6">
                  <div className="space-y-2">
                    <Label htmlFor="budget-period">Budget Period</Label>
                    <Select
                      value={selectedPeriod}
                      onValueChange={setSelectedPeriod}
                    >
                      <SelectTrigger id="budget-period">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="daily">Daily</SelectItem>
                        <SelectItem value="weekly">Weekly</SelectItem>
                        <SelectItem value="monthly">Monthly</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="space-y-4">
                    <div className="border rounded-lg p-4 space-y-4">
                      <h4 className="font-medium text-sm">
                        Organization-wide Budget
                      </h4>
                      <div className="grid gap-4 md:grid-cols-2">
                        <div className="space-y-2">
                          <Label htmlFor="org-budget">
                            Org Budget Limit ($)
                          </Label>
                          <Input
                            id="org-budget"
                            type="number"
                            value={orgBudgetLimit}
                            onChange={(e) => setOrgBudgetLimit(e.target.value)}
                            placeholder="1000"
                          />
                          <p className="text-xs text-muted-foreground">
                            Maximum spend for entire organization
                          </p>
                        </div>
                      </div>
                    </div>

                    <div className="border rounded-lg p-4 space-y-4">
                      <div className="flex items-center justify-between mb-2">
                        <h4 className="font-medium text-sm">
                          Team-level Budget (Optional)
                        </h4>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={addTeamBudget}
                        >
                          <Plus className="h-4 w-4 mr-1" />
                          Add Team Budget
                        </Button>
                      </div>
                      {teamBudgets.length === 0 ? (
                        <p className="text-sm text-muted-foreground">
                          No team budgets configured. Click "Add Team Budget" to
                          set limits for specific teams.
                        </p>
                      ) : (
                        <div className="space-y-3">
                          {teamBudgets.map((teamBudget) => (
                            <div
                              key={teamBudget.id}
                              className="border rounded p-3 space-y-3"
                            >
                              <div className="flex justify-end">
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  onClick={() =>
                                    removeTeamBudget(teamBudget.id)
                                  }
                                >
                                  <X className="h-4 w-4" />
                                </Button>
                              </div>
                              <div className="grid gap-4 md:grid-cols-2">
                                <div className="space-y-2">
                                  <Label>Team</Label>
                                  <Select
                                    value={teamBudget.teamId}
                                    onValueChange={(value) => {
                                      updateTeamBudget(
                                        teamBudget.id,
                                        "teamId",
                                        value,
                                      );
                                      const teamName =
                                        value === "engineering"
                                          ? "Engineering"
                                          : value === "support"
                                            ? "Support"
                                            : value === "marketing"
                                              ? "Marketing"
                                              : "";
                                      updateTeamBudget(
                                        teamBudget.id,
                                        "teamName",
                                        teamName,
                                      );
                                    }}
                                  >
                                    <SelectTrigger>
                                      <SelectValue placeholder="Choose a team" />
                                    </SelectTrigger>
                                    <SelectContent>
                                      <SelectItem value="engineering">
                                        Engineering
                                      </SelectItem>
                                      <SelectItem value="support">
                                        Support
                                      </SelectItem>
                                      <SelectItem value="marketing">
                                        Marketing
                                      </SelectItem>
                                    </SelectContent>
                                  </Select>
                                </div>
                                <div className="space-y-2">
                                  <Label>Budget Limit ($)</Label>
                                  <Input
                                    type="number"
                                    value={teamBudget.limit}
                                    onChange={(e) =>
                                      updateTeamBudget(
                                        teamBudget.id,
                                        "limit",
                                        e.target.value,
                                      )
                                    }
                                    placeholder="Enter budget limit"
                                  />
                                </div>
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>

                    <div className="border rounded-lg p-4 space-y-4">
                      <div className="flex items-center justify-between mb-2">
                        <h4 className="font-medium text-sm">
                          Agent-specific Budget (Optional)
                        </h4>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={addAgentBudget}
                        >
                          <Plus className="h-4 w-4 mr-1" />
                          Add Agent Budget
                        </Button>
                      </div>
                      {agentBudgets.length === 0 ? (
                        <p className="text-sm text-muted-foreground">
                          No agent budgets configured. Click "Add Agent Budget"
                          to set limits for specific agents.
                        </p>
                      ) : (
                        <div className="space-y-3">
                          {agentBudgets.map((agentBudget) => (
                            <div
                              key={agentBudget.id}
                              className="border rounded p-3 space-y-3"
                            >
                              <div className="flex justify-end">
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  onClick={() =>
                                    removeAgentBudget(agentBudget.id)
                                  }
                                >
                                  <X className="h-4 w-4" />
                                </Button>
                              </div>
                              <div className="grid gap-4 md:grid-cols-2">
                                <div className="space-y-2">
                                  <Label>Agent</Label>
                                  <Select
                                    value={agentBudget.agentId}
                                    onValueChange={(value) => {
                                      updateAgentBudget(
                                        agentBudget.id,
                                        "agentId",
                                        value,
                                      );
                                      const agentName =
                                        value === "support-bot"
                                          ? "Customer Support Bot"
                                          : value === "code-review"
                                            ? "Code Review Assistant"
                                            : value === "data-analyst"
                                              ? "Data Analyst"
                                              : value === "content-gen"
                                                ? "Content Generator"
                                                : "";
                                      updateAgentBudget(
                                        agentBudget.id,
                                        "agentName",
                                        agentName,
                                      );
                                    }}
                                  >
                                    <SelectTrigger>
                                      <SelectValue placeholder="Choose an agent" />
                                    </SelectTrigger>
                                    <SelectContent>
                                      <SelectItem value="support-bot">
                                        Customer Support Bot
                                      </SelectItem>
                                      <SelectItem value="code-review">
                                        Code Review Assistant
                                      </SelectItem>
                                      <SelectItem value="data-analyst">
                                        Data Analyst
                                      </SelectItem>
                                      <SelectItem value="content-gen">
                                        Content Generator
                                      </SelectItem>
                                    </SelectContent>
                                  </Select>
                                </div>
                                <div className="space-y-2">
                                  <Label>Budget Limit ($)</Label>
                                  <Input
                                    type="number"
                                    value={agentBudget.limit}
                                    onChange={(e) =>
                                      updateAgentBudget(
                                        agentBudget.id,
                                        "limit",
                                        e.target.value,
                                      )
                                    }
                                    placeholder="Enter budget limit"
                                  />
                                </div>
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>

                  <div className="flex items-center justify-between space-x-2">
                    <div className="space-y-0.5">
                      <Label htmlFor="auto-shutdown">
                        Auto-shutdown at limit
                      </Label>
                      <p className="text-xs text-muted-foreground">
                        Automatically disable agents when budget is exceeded
                      </p>
                    </div>
                    <Switch
                      id="auto-shutdown"
                      checked={autoShutdown}
                      onCheckedChange={setAutoShutdown}
                    />
                  </div>

                  <div className="flex justify-end">
                    <Button>Save Configuration</Button>
                  </div>
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="tool-limits" className="space-y-4">
              <Card>
                <CardHeader>
                  <CardTitle>Tool Call Limits Configuration</CardTitle>
                  <CardDescription>
                    Set call limits for MCP servers and specific tools at
                    different levels
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-6">
                  <div className="space-y-4">
                    <div className="border rounded-lg p-4 space-y-4">
                      <div className="flex items-center justify-between mb-2">
                        <h4 className="font-medium text-sm">
                          Organization-wide Tool Limits
                        </h4>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => addToolCallLimit("org")}
                        >
                          <Plus className="h-4 w-4 mr-1" />
                          Add Org Limit
                        </Button>
                      </div>
                      {toolCallLimits.filter((l) => l.level === "org")
                        .length === 0 ? (
                        <p className="text-sm text-muted-foreground">
                          No organization-wide tool limits configured. Click
                          "Add Org Limit" to set limits.
                        </p>
                      ) : (
                        <div className="space-y-3">
                          {toolCallLimits
                            .filter((l) => l.level === "org")
                            .map((limit) => (
                              <div
                                key={limit.id}
                                className="border rounded p-3 space-y-3"
                              >
                                <div className="flex justify-end">
                                  <Button
                                    size="sm"
                                    variant="ghost"
                                    onClick={() =>
                                      removeToolCallLimit(limit.id)
                                    }
                                  >
                                    <X className="h-4 w-4" />
                                  </Button>
                                </div>
                                <div className="grid gap-4">
                                  <div className="space-y-2">
                                    <Label>MCP Servers</Label>
                                    <Select>
                                      <SelectTrigger>
                                        <SelectValue placeholder="Select MCP servers (optional)" />
                                      </SelectTrigger>
                                      <SelectContent>
                                        <SelectItem value="github">
                                          GitHub MCP
                                        </SelectItem>
                                        <SelectItem value="slack">
                                          Slack MCP
                                        </SelectItem>
                                        <SelectItem value="jira">
                                          Jira MCP
                                        </SelectItem>
                                        <SelectItem value="database">
                                          Database MCP
                                        </SelectItem>
                                      </SelectContent>
                                    </Select>
                                    <p className="text-xs text-muted-foreground">
                                      Leave empty to apply to all MCP servers
                                    </p>
                                  </div>
                                  <div className="space-y-2">
                                    <Label>Specific Tools</Label>
                                    <Select>
                                      <SelectTrigger>
                                        <SelectValue placeholder="Select specific tools (optional)" />
                                      </SelectTrigger>
                                      <SelectContent>
                                        <SelectItem value="create-pr">
                                          Create Pull Request
                                        </SelectItem>
                                        <SelectItem value="query-db">
                                          Query Database
                                        </SelectItem>
                                        <SelectItem value="send-email">
                                          Send Email
                                        </SelectItem>
                                        <SelectItem value="api-call">
                                          External API Call
                                        </SelectItem>
                                      </SelectContent>
                                    </Select>
                                    <p className="text-xs text-muted-foreground">
                                      Leave empty to apply to all tools
                                    </p>
                                  </div>
                                  <div className="grid gap-4 md:grid-cols-2">
                                    <div className="space-y-2">
                                      <Label>Daily Call Limit</Label>
                                      <Input
                                        type="number"
                                        value={limit.dailyLimit}
                                        onChange={(e) =>
                                          updateToolCallLimit(limit.id, {
                                            dailyLimit: e.target.value,
                                          })
                                        }
                                        placeholder="e.g., 1000"
                                      />
                                    </div>
                                    <div className="space-y-2">
                                      <Label>Monthly Call Limit</Label>
                                      <Input
                                        type="number"
                                        value={limit.monthlyLimit}
                                        onChange={(e) =>
                                          updateToolCallLimit(limit.id, {
                                            monthlyLimit: e.target.value,
                                          })
                                        }
                                        placeholder="e.g., 30000"
                                      />
                                    </div>
                                  </div>
                                </div>
                              </div>
                            ))}
                        </div>
                      )}
                    </div>

                    <div className="border rounded-lg p-4 space-y-4">
                      <div className="flex items-center justify-between mb-2">
                        <h4 className="font-medium text-sm">
                          Team-level Tool Limits
                        </h4>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => addToolCallLimit("team")}
                        >
                          <Plus className="h-4 w-4 mr-1" />
                          Add Team Limit
                        </Button>
                      </div>
                      {toolCallLimits.filter((l) => l.level === "team")
                        .length === 0 ? (
                        <p className="text-sm text-muted-foreground">
                          No team tool limits configured. Click "Add Team Limit"
                          to set limits for specific teams.
                        </p>
                      ) : (
                        <div className="space-y-3">
                          {toolCallLimits
                            .filter((l) => l.level === "team")
                            .map((limit) => (
                              <div
                                key={limit.id}
                                className="border rounded p-3 space-y-3"
                              >
                                <div className="flex justify-end">
                                  <Button
                                    size="sm"
                                    variant="ghost"
                                    onClick={() =>
                                      removeToolCallLimit(limit.id)
                                    }
                                  >
                                    <X className="h-4 w-4" />
                                  </Button>
                                </div>
                                <div className="grid gap-4">
                                  <div className="space-y-2">
                                    <Label>Team</Label>
                                    <Select
                                      value={limit.teamId}
                                      onValueChange={(value) =>
                                        updateToolCallLimit(limit.id, {
                                          teamId: value,
                                        })
                                      }
                                    >
                                      <SelectTrigger>
                                        <SelectValue placeholder="Choose a team" />
                                      </SelectTrigger>
                                      <SelectContent>
                                        <SelectItem value="engineering">
                                          Engineering
                                        </SelectItem>
                                        <SelectItem value="support">
                                          Support
                                        </SelectItem>
                                        <SelectItem value="marketing">
                                          Marketing
                                        </SelectItem>
                                      </SelectContent>
                                    </Select>
                                  </div>
                                  <div className="space-y-2">
                                    <Label>MCP Servers</Label>
                                    <Select>
                                      <SelectTrigger>
                                        <SelectValue placeholder="Select MCP servers (optional)" />
                                      </SelectTrigger>
                                      <SelectContent>
                                        <SelectItem value="github">
                                          GitHub MCP
                                        </SelectItem>
                                        <SelectItem value="slack">
                                          Slack MCP
                                        </SelectItem>
                                        <SelectItem value="jira">
                                          Jira MCP
                                        </SelectItem>
                                        <SelectItem value="database">
                                          Database MCP
                                        </SelectItem>
                                      </SelectContent>
                                    </Select>
                                  </div>
                                  <div className="space-y-2">
                                    <Label>Specific Tools</Label>
                                    <Select>
                                      <SelectTrigger>
                                        <SelectValue placeholder="Select specific tools (optional)" />
                                      </SelectTrigger>
                                      <SelectContent>
                                        <SelectItem value="create-pr">
                                          Create Pull Request
                                        </SelectItem>
                                        <SelectItem value="query-db">
                                          Query Database
                                        </SelectItem>
                                        <SelectItem value="send-email">
                                          Send Email
                                        </SelectItem>
                                        <SelectItem value="api-call">
                                          External API Call
                                        </SelectItem>
                                      </SelectContent>
                                    </Select>
                                  </div>
                                  <div className="grid gap-4 md:grid-cols-2">
                                    <div className="space-y-2">
                                      <Label>Daily Call Limit</Label>
                                      <Input
                                        type="number"
                                        value={limit.dailyLimit}
                                        onChange={(e) =>
                                          updateToolCallLimit(limit.id, {
                                            dailyLimit: e.target.value,
                                          })
                                        }
                                        placeholder="e.g., 500"
                                      />
                                    </div>
                                    <div className="space-y-2">
                                      <Label>Monthly Call Limit</Label>
                                      <Input
                                        type="number"
                                        value={limit.monthlyLimit}
                                        onChange={(e) =>
                                          updateToolCallLimit(limit.id, {
                                            monthlyLimit: e.target.value,
                                          })
                                        }
                                        placeholder="e.g., 15000"
                                      />
                                    </div>
                                  </div>
                                </div>
                              </div>
                            ))}
                        </div>
                      )}
                    </div>

                    <div className="border rounded-lg p-4 space-y-4">
                      <div className="flex items-center justify-between mb-2">
                        <h4 className="font-medium text-sm">
                          Agent-specific Tool Limits
                        </h4>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => addToolCallLimit("agent")}
                        >
                          <Plus className="h-4 w-4 mr-1" />
                          Add Agent Limit
                        </Button>
                      </div>
                      {toolCallLimits.filter((l) => l.level === "agent")
                        .length === 0 ? (
                        <p className="text-sm text-muted-foreground">
                          No agent tool limits configured. Click "Add Agent
                          Limit" to set limits for specific agents.
                        </p>
                      ) : (
                        <div className="space-y-3">
                          {toolCallLimits
                            .filter((l) => l.level === "agent")
                            .map((limit) => (
                              <div
                                key={limit.id}
                                className="border rounded p-3 space-y-3"
                              >
                                <div className="flex justify-end">
                                  <Button
                                    size="sm"
                                    variant="ghost"
                                    onClick={() =>
                                      removeToolCallLimit(limit.id)
                                    }
                                  >
                                    <X className="h-4 w-4" />
                                  </Button>
                                </div>
                                <div className="grid gap-4">
                                  <div className="space-y-2">
                                    <Label>Agent</Label>
                                    <Select
                                      value={limit.agentId}
                                      onValueChange={(value) =>
                                        updateToolCallLimit(limit.id, {
                                          agentId: value,
                                        })
                                      }
                                    >
                                      <SelectTrigger>
                                        <SelectValue placeholder="Choose an agent" />
                                      </SelectTrigger>
                                      <SelectContent>
                                        <SelectItem value="support-bot">
                                          Customer Support Bot
                                        </SelectItem>
                                        <SelectItem value="code-review">
                                          Code Review Assistant
                                        </SelectItem>
                                        <SelectItem value="data-analyst">
                                          Data Analyst
                                        </SelectItem>
                                        <SelectItem value="content-gen">
                                          Content Generator
                                        </SelectItem>
                                      </SelectContent>
                                    </Select>
                                  </div>
                                  <div className="space-y-2">
                                    <Label>MCP Servers</Label>
                                    <Select>
                                      <SelectTrigger>
                                        <SelectValue placeholder="Select MCP servers (optional)" />
                                      </SelectTrigger>
                                      <SelectContent>
                                        <SelectItem value="github">
                                          GitHub MCP
                                        </SelectItem>
                                        <SelectItem value="slack">
                                          Slack MCP
                                        </SelectItem>
                                        <SelectItem value="jira">
                                          Jira MCP
                                        </SelectItem>
                                        <SelectItem value="database">
                                          Database MCP
                                        </SelectItem>
                                      </SelectContent>
                                    </Select>
                                  </div>
                                  <div className="space-y-2">
                                    <Label>Specific Tools</Label>
                                    <Select>
                                      <SelectTrigger>
                                        <SelectValue placeholder="Select specific tools (optional)" />
                                      </SelectTrigger>
                                      <SelectContent>
                                        <SelectItem value="create-pr">
                                          Create Pull Request
                                        </SelectItem>
                                        <SelectItem value="query-db">
                                          Query Database
                                        </SelectItem>
                                        <SelectItem value="send-email">
                                          Send Email
                                        </SelectItem>
                                        <SelectItem value="api-call">
                                          External API Call
                                        </SelectItem>
                                      </SelectContent>
                                    </Select>
                                  </div>
                                  <div className="grid gap-4 md:grid-cols-2">
                                    <div className="space-y-2">
                                      <Label>Daily Call Limit</Label>
                                      <Input
                                        type="number"
                                        value={limit.dailyLimit}
                                        onChange={(e) =>
                                          updateToolCallLimit(limit.id, {
                                            dailyLimit: e.target.value,
                                          })
                                        }
                                        placeholder="e.g., 100"
                                      />
                                    </div>
                                    <div className="space-y-2">
                                      <Label>Monthly Call Limit</Label>
                                      <Input
                                        type="number"
                                        value={limit.monthlyLimit}
                                        onChange={(e) =>
                                          updateToolCallLimit(limit.id, {
                                            monthlyLimit: e.target.value,
                                          })
                                        }
                                        placeholder="e.g., 3000"
                                      />
                                    </div>
                                  </div>
                                </div>
                              </div>
                            ))}
                        </div>
                      )}
                    </div>
                  </div>

                  <div className="flex justify-end">
                    <Button>Save Configuration</Button>
                  </div>
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="token-pricing" className="space-y-4">
              <Card>
                <CardHeader>
                  <CardTitle>Token Pricing Configuration</CardTitle>
                  <CardDescription>
                    Configure the cost per million tokens for different LLM
                    models
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-6">
                  <div className="space-y-4">
                    <div className="text-sm text-muted-foreground">
                      Prices are in USD per 1 million tokens. These prices are
                      used to calculate usage costs.
                    </div>

                    {isLoadingPrices ? (
                      <div className="text-center py-4 text-muted-foreground">
                        Loading token prices...
                      </div>
                    ) : tokenPrices.length === 0 ? (
                      <div className="text-center py-4 text-muted-foreground">
                        No token prices configured. Prices will be auto-created
                        when models are used.
                      </div>
                    ) : null}

                    {/* Group prices by provider */}
                    {!isLoadingPrices &&
                      [...new Set(tokenPrices.map((p) => p.provider))].map(
                        (providerName) => (
                          <div
                            key={providerName}
                            className="border rounded-lg p-4 space-y-4"
                          >
                            <h4 className="font-medium text-sm">
                              {providerName}
                            </h4>
                            <div className="space-y-3">
                              {tokenPrices
                                .filter(
                                  (price) => price.provider === providerName,
                                )
                                .map((price) => {
                                  const currentPrice =
                                    editedPrices[price.id] || price;
                                  return (
                                    <div
                                      key={`${price.provider}-${price.model}`}
                                      className="grid gap-4 md:grid-cols-3"
                                    >
                                      <div className="space-y-2">
                                        <Label className="text-xs">Model</Label>
                                        <Input
                                          value={currentPrice.model}
                                          disabled
                                          className="text-sm"
                                        />
                                      </div>
                                      <div className="space-y-2">
                                        <Label className="text-xs">
                                          Input ($/1M tokens)
                                        </Label>
                                        <Input
                                          type="number"
                                          step="0.001"
                                          value={currentPrice.inputPricePer1M}
                                          onChange={(e) => {
                                            setEditedPrices((prev) => ({
                                              ...prev,
                                              [price.id]: {
                                                ...price,
                                                inputPricePer1M: e.target.value,
                                              },
                                            }));
                                          }}
                                          placeholder="0.00"
                                          className="text-sm"
                                        />
                                      </div>
                                      <div className="space-y-2">
                                        <Label className="text-xs">
                                          Output ($/1M tokens)
                                        </Label>
                                        <Input
                                          type="number"
                                          step="0.001"
                                          value={currentPrice.outputPricePer1M}
                                          onChange={(e) => {
                                            setEditedPrices((prev) => ({
                                              ...prev,
                                              [price.id]: {
                                                ...price,
                                                outputPricePer1M:
                                                  e.target.value,
                                              },
                                            }));
                                          }}
                                          placeholder="0.00"
                                          className="text-sm"
                                        />
                                      </div>
                                    </div>
                                  );
                                })}
                            </div>
                          </div>
                        ),
                      )}
                  </div>

                  <div className="flex justify-end">
                    <Button
                      onClick={() => {
                        const pricesToUpdate: UpdateTokenPriceInput[] =
                          Object.values(editedPrices).map((price) => ({
                            id: price.id,
                            inputPricePer1M: price.inputPricePer1M,
                            outputPricePer1M: price.outputPricePer1M,
                          }));
                        if (pricesToUpdate.length > 0) {
                          updateTokenPricesMutation.mutate(pricesToUpdate);
                          setEditedPrices({});
                        }
                      }}
                      disabled={
                        updateTokenPricesMutation.isPending ||
                        Object.keys(editedPrices).length === 0
                      }
                    >
                      {updateTokenPricesMutation.isPending
                        ? "Saving..."
                        : "Save Pricing Configuration"}
                    </Button>
                  </div>
                </CardContent>
              </Card>
            </TabsContent>
          </Tabs>
        </div>
      </div>
    </div>
  );
}
