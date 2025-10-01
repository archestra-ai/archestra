"use client";

import { Trash2, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import {
  assignToolInvocationPolicyToAgent,
  assignTrustedDataPolicyToAgent,
  createToolInvocationPolicy,
  createTrustedDataPolicy,
  deleteToolInvocationPolicy,
  deleteTrustedDataPolicy,
  type GetAgentsResponse,
  type GetOperatorsResponse,
  type GetToolInvocationPoliciesResponse,
  type GetToolsResponse,
  type GetTrustedDataPoliciesResponse,
  getAgents,
  getAgentToolInvocationPolicies,
  getAgentTrustedDataPolicies,
  getOperators,
  getToolInvocationPolicies,
  getTools,
  getTrustedDataPolicies,
  unassignToolInvocationPolicyFromAgent,
  unassignTrustedDataPolicyFromAgent,
} from "shared/api-client";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

type Tool = GetToolsResponse[number];
type ToolInvocationPolicy = GetToolInvocationPoliciesResponse[number];
type TrustedDataPolicy = GetTrustedDataPoliciesResponse[number];
type Operator = GetOperatorsResponse[number];
type OperatorValue = Operator["value"];
type Agent = GetAgentsResponse[number];

export default function SettingsPage() {
  const [tools, setTools] = useState<Tool[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [toolInvocationPolicies, setToolInvocationPolicies] = useState<
    ToolInvocationPolicy[]
  >([]);
  const [trustedDataPolicies, setTrustedDataPolicies] = useState<
    TrustedDataPolicy[]
  >([]);
  const [operators, setOperators] = useState<Operator[]>([]);
  const [loading, setLoading] = useState(true);

  // Track which agents are assigned to each policy
  const [tipAgentAssignments, setTipAgentAssignments] = useState<
    Record<string, string[]>
  >({});
  const [tdpAgentAssignments, setTdpAgentAssignments] = useState<
    Record<string, string[]>
  >({});

  // Tool Invocation Policy Form State
  const [newToolInvocationPolicy, setNewToolInvocationPolicy] = useState<{
    toolId: string;
    description: string;
    argumentName: string;
    operator: OperatorValue;
    value: string;
    action: "allow" | "block";
    blockPrompt: string;
  }>({
    toolId: "",
    description: "",
    argumentName: "",
    operator: "equal",
    value: "",
    action: "block",
    blockPrompt: "",
  });

  // Trusted Data Policy Form State
  const [newTrustedDataPolicy, setNewTrustedDataPolicy] = useState<{
    toolId: string;
    description: string;
    attributePath: string;
    operator: OperatorValue;
    value: string;
  }>({
    toolId: "",
    description: "",
    attributePath: "",
    operator: "equal",
    value: "",
  });

  const fetchData = useCallback(async () => {
    try {
      const [toolsRes, tipRes, tdpRes, opsRes, agentsRes] = await Promise.all([
        getTools(),
        getToolInvocationPolicies(),
        getTrustedDataPolicies(),
        getOperators(),
        getAgents(),
      ]);

      const toolsData = toolsRes.data || [];
      const tipData = tipRes.data || [];
      const tdpData = tdpRes.data || [];
      const agentsData = agentsRes.data || [];

      setTools(toolsData);
      setToolInvocationPolicies(tipData);
      setTrustedDataPolicies(tdpData);
      setOperators(opsRes.data || []);
      setAgents(agentsData);

      // Fetch agent assignments for each policy
      const tipAssignments: Record<string, string[]> = {};
      const tdpAssignments: Record<string, string[]> = {};

      for (const agent of agentsData) {
        const [agentTipRes, agentTdpRes] = await Promise.all([
          getAgentToolInvocationPolicies({ path: { id: agent.id } }),
          getAgentTrustedDataPolicies({ path: { id: agent.id } }),
        ]);

        // Build reverse mapping: policyId -> agentIds[]
        for (const policy of agentTipRes.data || []) {
          if (!tipAssignments[policy.id]) {
            tipAssignments[policy.id] = [];
          }
          tipAssignments[policy.id].push(agent.id);
        }

        for (const policy of agentTdpRes.data || []) {
          if (!tdpAssignments[policy.id]) {
            tdpAssignments[policy.id] = [];
          }
          tdpAssignments[policy.id].push(agent.id);
        }
      }

      setTipAgentAssignments(tipAssignments);
      setTdpAgentAssignments(tdpAssignments);
    } catch (error) {
      console.error("Failed to fetch data:", error);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const handleCreateToolInvocationPolicy = useCallback(
    async (e: React.FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      try {
        await createToolInvocationPolicy({
          body: {
            ...newToolInvocationPolicy,
            blockPrompt: newToolInvocationPolicy.blockPrompt || null,
          },
        });
        await fetchData();
        setNewToolInvocationPolicy({
          toolId: "",
          description: "",
          argumentName: "",
          operator: "equal",
          value: "",
          action: "block",
          blockPrompt: "",
        });
      } catch (error) {
        console.error("Failed to create policy:", error);
      }
    },
    [fetchData, newToolInvocationPolicy],
  );

  const handleDeleteToolInvocationPolicy = useCallback(
    async (id: string) => {
      try {
        await deleteToolInvocationPolicy({
          path: { id },
        });
        await fetchData();
      } catch (error) {
        console.error("Failed to delete policy:", error);
      }
    },
    [fetchData],
  );

  const handleCreateTrustedDataPolicy = useCallback(
    async (e: React.FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      try {
        await createTrustedDataPolicy({
          body: newTrustedDataPolicy,
        });
        await fetchData();
        setNewTrustedDataPolicy({
          toolId: "",
          description: "",
          attributePath: "",
          operator: "equal",
          value: "",
        });
      } catch (error) {
        console.error("Failed to create policy:", error);
      }
    },
    [fetchData, newTrustedDataPolicy],
  );

  const handleDeleteTrustedDataPolicy = useCallback(
    async (id: string) => {
      try {
        await deleteTrustedDataPolicy({
          path: { id },
        });
        await fetchData();
      } catch (error) {
        console.error("Failed to delete policy:", error);
      }
    },
    [fetchData],
  );

  // Agent assignment handlers for Tool Invocation Policies
  const handleAssignAgentToTip = useCallback(
    async (policyId: string, agentId: string) => {
      try {
        await assignToolInvocationPolicyToAgent({
          path: { id: agentId, policyId },
        });
        await fetchData();
      } catch (error) {
        console.error("Failed to assign agent to policy:", error);
      }
    },
    [fetchData],
  );

  const handleUnassignAgentFromTip = useCallback(
    async (policyId: string, agentId: string) => {
      try {
        await unassignToolInvocationPolicyFromAgent({
          path: { id: agentId, policyId },
        });
        await fetchData();
      } catch (error) {
        console.error("Failed to unassign agent from policy:", error);
      }
    },
    [fetchData],
  );

  // Agent assignment handlers for Trusted Data Policies
  const handleAssignAgentToTdp = useCallback(
    async (policyId: string, agentId: string) => {
      try {
        await assignTrustedDataPolicyToAgent({
          path: { id: agentId, policyId },
        });
        await fetchData();
      } catch (error) {
        console.error("Failed to assign agent to policy:", error);
      }
    },
    [fetchData],
  );

  const handleUnassignAgentFromTdp = useCallback(
    async (policyId: string, agentId: string) => {
      try {
        await unassignTrustedDataPolicyFromAgent({
          path: { id: agentId, policyId },
        });
        await fetchData();
      } catch (error) {
        console.error("Failed to unassign agent from policy:", error);
      }
    },
    [fetchData],
  );

  const getToolName = useCallback(
    (toolId: string) => {
      return tools.find((t) => t.id === toolId)?.name || "Unknown Tool";
    },
    [tools],
  );

  const getAgentName = useCallback(
    (agentId: string) => {
      return agents.find((a) => a.id === agentId)?.name || "Unknown Agent";
    },
    [agents],
  );

  if (loading) {
    return (
      <div className="flex items-center justify-center h-screen">
        Loading...
      </div>
    );
  }

  return (
    <div className="container mx-auto p-6 max-w-6xl">
      <h1 className="text-3xl font-bold mb-6">Tool Configurations</h1>

      <Tabs defaultValue="tool-invocation" className="w-full">
        <TabsList className="grid w-full grid-cols-2">
          <TabsTrigger value="tool-invocation">
            Tool Invocation Policies
          </TabsTrigger>
          <TabsTrigger value="trusted-data">Trusted Data Policies</TabsTrigger>
        </TabsList>

        {/* Tool Invocation Policies Tab */}
        <TabsContent value="tool-invocation" className="space-y-6">
          {/* Add New Policy Form */}
          <Card>
            <CardHeader>
              <CardTitle>Add Tool Invocation Policy</CardTitle>
            </CardHeader>
            <CardContent>
              <form
                onSubmit={handleCreateToolInvocationPolicy}
                className="space-y-4"
              >
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label htmlFor="tip-tool">Tool</Label>
                    <Select
                      value={newToolInvocationPolicy.toolId}
                      onValueChange={(value) =>
                        setNewToolInvocationPolicy({
                          ...newToolInvocationPolicy,
                          toolId: value,
                        })
                      }
                      required
                    >
                      <SelectTrigger id="tip-tool">
                        <SelectValue placeholder="Select a tool" />
                      </SelectTrigger>
                      <SelectContent>
                        {tools.map((tool) => (
                          <SelectItem key={tool.id} value={tool.id}>
                            {tool.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="tip-action">Action</Label>
                    <Select
                      value={newToolInvocationPolicy.action}
                      onValueChange={(value: "allow" | "block") =>
                        setNewToolInvocationPolicy({
                          ...newToolInvocationPolicy,
                          action: value,
                        })
                      }
                      required
                    >
                      <SelectTrigger id="tip-action">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="block">Block</SelectItem>
                        <SelectItem value="allow">Allow</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="tip-argument">Argument Name</Label>
                    <Input
                      id="tip-argument"
                      value={newToolInvocationPolicy.argumentName}
                      onChange={(e) =>
                        setNewToolInvocationPolicy({
                          ...newToolInvocationPolicy,
                          argumentName: e.target.value,
                        })
                      }
                      placeholder="e.g., recipient, to, path"
                      required
                    />
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="tip-operator">Operator</Label>
                    <Select
                      value={newToolInvocationPolicy.operator}
                      onValueChange={(value) =>
                        setNewToolInvocationPolicy({
                          ...newToolInvocationPolicy,
                          operator: value as OperatorValue,
                        })
                      }
                      required
                    >
                      <SelectTrigger id="tip-operator">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {operators.map((op) => (
                          <SelectItem key={op.value} value={op.value}>
                            {op.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="space-y-2 col-span-2">
                    <Label htmlFor="tip-value">Value</Label>
                    <Input
                      id="tip-value"
                      value={newToolInvocationPolicy.value}
                      onChange={(e) =>
                        setNewToolInvocationPolicy({
                          ...newToolInvocationPolicy,
                          value: e.target.value,
                        })
                      }
                      placeholder="e.g., hacker@hacker.com, @grafana.com"
                      required
                    />
                  </div>

                  <div className="space-y-2 col-span-2">
                    <Label htmlFor="tip-description">Description</Label>
                    <Input
                      id="tip-description"
                      value={newToolInvocationPolicy.description}
                      onChange={(e) =>
                        setNewToolInvocationPolicy({
                          ...newToolInvocationPolicy,
                          description: e.target.value,
                        })
                      }
                      placeholder="Describe the policy"
                      required
                    />
                  </div>

                  <div className="space-y-2 col-span-2">
                    <Label htmlFor="tip-block-prompt">
                      Block Prompt (Optional)
                    </Label>
                    <Input
                      id="tip-block-prompt"
                      value={newToolInvocationPolicy.blockPrompt}
                      onChange={(e) =>
                        setNewToolInvocationPolicy({
                          ...newToolInvocationPolicy,
                          blockPrompt: e.target.value,
                        })
                      }
                      placeholder="Custom message when blocked"
                    />
                  </div>
                </div>

                <Button type="submit" className="w-full">
                  Add Policy
                </Button>
              </form>
            </CardContent>
          </Card>

          {/* Existing Policies List */}
          <div className="space-y-4">
            <h2 className="text-xl font-semibold">Existing Policies</h2>
            {toolInvocationPolicies.length === 0 ? (
              <p className="text-muted-foreground">No policies configured</p>
            ) : (
              toolInvocationPolicies.map((policy) => (
                <Card key={policy.id}>
                  <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                    <CardTitle className="text-sm font-medium">
                      {getToolName(policy.toolId)}
                    </CardTitle>
                    <div className="flex items-center gap-2">
                      <span
                        className={`text-xs px-2 py-1 rounded ${
                          policy.action === "block"
                            ? "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200"
                            : "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200"
                        }`}
                      >
                        {policy.action}
                      </span>
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() =>
                          handleDeleteToolInvocationPolicy(policy.id)
                        }
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </CardHeader>
                  <CardContent>
                    <div className="space-y-3 text-sm">
                      <p className="font-medium">{policy.description}</p>
                      <div className="bg-muted p-2 rounded font-mono text-xs">
                        {policy.argumentName} {policy.operator} "{policy.value}"
                      </div>
                      {policy.blockPrompt && (
                        <p className="text-muted-foreground italic">
                          Block message: {policy.blockPrompt}
                        </p>
                      )}

                      {/* Agent Assignment Section */}
                      <div className="pt-2 border-t">
                        <div className="flex items-center justify-between mb-2">
                          <Label className="text-xs font-semibold">
                            Assigned Agents
                          </Label>
                          <Select
                            onValueChange={(agentId) =>
                              handleAssignAgentToTip(policy.id, agentId)
                            }
                          >
                            <SelectTrigger className="w-[180px] h-8">
                              <SelectValue placeholder="Assign agent..." />
                            </SelectTrigger>
                            <SelectContent>
                              {agents
                                .filter(
                                  (agent) =>
                                    !tipAgentAssignments[policy.id]?.includes(
                                      agent.id,
                                    ),
                                )
                                .map((agent) => (
                                  <SelectItem key={agent.id} value={agent.id}>
                                    {agent.name}
                                  </SelectItem>
                                ))}
                            </SelectContent>
                          </Select>
                        </div>

                        {tipAgentAssignments[policy.id]?.length > 0 ? (
                          <div className="flex flex-wrap gap-2">
                            {tipAgentAssignments[policy.id].map((agentId) => (
                              <div
                                key={agentId}
                                className="flex items-center gap-1 bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200 px-2 py-1 rounded text-xs"
                              >
                                {getAgentName(agentId)}
                                <button
                                  type="button"
                                  onClick={() =>
                                    handleUnassignAgentFromTip(
                                      policy.id,
                                      agentId,
                                    )
                                  }
                                  className="hover:bg-blue-200 dark:hover:bg-blue-800 rounded p-0.5"
                                >
                                  <X className="h-3 w-3" />
                                </button>
                              </div>
                            ))}
                          </div>
                        ) : (
                          <p className="text-xs text-muted-foreground italic">
                            No agents assigned
                          </p>
                        )}
                      </div>
                    </div>
                  </CardContent>
                </Card>
              ))
            )}
          </div>
        </TabsContent>

        {/* Trusted Data Policies Tab */}
        <TabsContent value="trusted-data" className="space-y-6">
          {/* Add New Policy Form */}
          <Card>
            <CardHeader>
              <CardTitle>Add Trusted Data Policy</CardTitle>
            </CardHeader>
            <CardContent>
              <form
                onSubmit={handleCreateTrustedDataPolicy}
                className="space-y-4"
              >
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2 col-span-2">
                    <Label htmlFor="tdp-tool">Tool</Label>
                    <Select
                      value={newTrustedDataPolicy.toolId}
                      onValueChange={(value) =>
                        setNewTrustedDataPolicy({
                          ...newTrustedDataPolicy,
                          toolId: value,
                        })
                      }
                      required
                    >
                      <SelectTrigger id="tdp-tool">
                        <SelectValue placeholder="Select a tool" />
                      </SelectTrigger>
                      <SelectContent>
                        {tools.map((tool) => (
                          <SelectItem key={tool.id} value={tool.id}>
                            {tool.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="tdp-attribute">Attribute Path</Label>
                    <Input
                      id="tdp-attribute"
                      value={newTrustedDataPolicy.attributePath}
                      onChange={(e) =>
                        setNewTrustedDataPolicy({
                          ...newTrustedDataPolicy,
                          attributePath: e.target.value,
                        })
                      }
                      placeholder="e.g., emails[*].from, path"
                      required
                    />
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="tdp-operator">Operator</Label>
                    <Select
                      value={newTrustedDataPolicy.operator}
                      onValueChange={(value) =>
                        setNewTrustedDataPolicy({
                          ...newTrustedDataPolicy,
                          operator: value as OperatorValue,
                        })
                      }
                      required
                    >
                      <SelectTrigger id="tdp-operator">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {operators.map((op) => (
                          <SelectItem key={op.value} value={op.value}>
                            {op.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="space-y-2 col-span-2">
                    <Label htmlFor="tdp-value">Value</Label>
                    <Input
                      id="tdp-value"
                      value={newTrustedDataPolicy.value}
                      onChange={(e) =>
                        setNewTrustedDataPolicy({
                          ...newTrustedDataPolicy,
                          value: e.target.value,
                        })
                      }
                      placeholder="e.g., @archestra.ai, .*/Desktop.*"
                      required
                    />
                  </div>

                  <div className="space-y-2 col-span-2">
                    <Label htmlFor="tdp-description">Description</Label>
                    <Input
                      id="tdp-description"
                      value={newTrustedDataPolicy.description}
                      onChange={(e) =>
                        setNewTrustedDataPolicy({
                          ...newTrustedDataPolicy,
                          description: e.target.value,
                        })
                      }
                      placeholder="Describe the policy"
                      required
                    />
                  </div>
                </div>

                <Button type="submit" className="w-full">
                  Add Policy
                </Button>
              </form>
            </CardContent>
          </Card>

          {/* Existing Policies List */}
          <div className="space-y-4">
            <h2 className="text-xl font-semibold">Existing Policies</h2>
            {trustedDataPolicies.length === 0 ? (
              <p className="text-muted-foreground">No policies configured</p>
            ) : (
              trustedDataPolicies.map((policy) => (
                <Card key={policy.id}>
                  <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                    <CardTitle className="text-sm font-medium">
                      {getToolName(policy.toolId)}
                    </CardTitle>
                    <div className="flex items-center gap-2">
                      <span className="text-xs px-2 py-1 rounded bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200">
                        mark trusted
                      </span>
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => handleDeleteTrustedDataPolicy(policy.id)}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </CardHeader>
                  <CardContent>
                    <div className="space-y-3 text-sm">
                      <p className="font-medium">{policy.description}</p>
                      <div className="bg-muted p-2 rounded font-mono text-xs">
                        {policy.attributePath} {policy.operator} "{policy.value}
                        "
                      </div>

                      {/* Agent Assignment Section */}
                      <div className="pt-2 border-t">
                        <div className="flex items-center justify-between mb-2">
                          <Label className="text-xs font-semibold">
                            Assigned Agents
                          </Label>
                          <Select
                            onValueChange={(agentId) =>
                              handleAssignAgentToTdp(policy.id, agentId)
                            }
                          >
                            <SelectTrigger className="w-[180px] h-8">
                              <SelectValue placeholder="Assign agent..." />
                            </SelectTrigger>
                            <SelectContent>
                              {agents
                                .filter(
                                  (agent) =>
                                    !tdpAgentAssignments[policy.id]?.includes(
                                      agent.id,
                                    ),
                                )
                                .map((agent) => (
                                  <SelectItem key={agent.id} value={agent.id}>
                                    {agent.name}
                                  </SelectItem>
                                ))}
                            </SelectContent>
                          </Select>
                        </div>

                        {tdpAgentAssignments[policy.id]?.length > 0 ? (
                          <div className="flex flex-wrap gap-2">
                            {tdpAgentAssignments[policy.id].map((agentId) => (
                              <div
                                key={agentId}
                                className="flex items-center gap-1 bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200 px-2 py-1 rounded text-xs"
                              >
                                {getAgentName(agentId)}
                                <button
                                  type="button"
                                  onClick={() =>
                                    handleUnassignAgentFromTdp(
                                      policy.id,
                                      agentId,
                                    )
                                  }
                                  className="hover:bg-blue-200 dark:hover:bg-blue-800 rounded p-0.5"
                                >
                                  <X className="h-3 w-3" />
                                </button>
                              </div>
                            ))}
                          </div>
                        ) : (
                          <p className="text-xs text-muted-foreground italic">
                            No agents assigned
                          </p>
                        )}
                      </div>
                    </div>
                  </CardContent>
                </Card>
              ))
            )}
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}
