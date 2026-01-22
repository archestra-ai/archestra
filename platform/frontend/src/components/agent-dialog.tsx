"use client";

import type { archestraApiTypes } from "@shared";
import { archestraApiSdk } from "@shared";
import { useQuery } from "@tanstack/react-query";
import { Bot, Loader2, Wrench, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import {
  type ProfileLabel,
  ProfileLabels,
  type ProfileLabelsRef,
} from "@/components/agent-labels";
import { ChatToolsDisplay } from "@/components/chat/chat-tools-display";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@/components/ui/hover-card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MultiSelectCombobox } from "@/components/ui/multi-select-combobox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import {
  useCreateProfile,
  useInternalAgents,
  useLabelKeys,
  useUpdateProfile,
} from "@/lib/agent.query";
import {
  useAgentDelegations,
  useSyncAgentDelegations,
} from "@/lib/agent-tools.query";
import { useHasPermissions } from "@/lib/auth.query";
import { useChatProfileMcpTools } from "@/lib/chat.query";
import { useChatOpsStatus } from "@/lib/chatops.query";

type Agent = archestraApiTypes.GetAllAgentsResponses["200"][number];

// Component to display tools for a specific agent
function AgentToolsList({ agentId }: { agentId: string }) {
  const { data: tools = [], isLoading } = useChatProfileMcpTools(agentId);

  if (isLoading) {
    return <p className="text-xs text-muted-foreground">Loading tools...</p>;
  }

  if (tools.length === 0) {
    return <p className="text-xs text-muted-foreground">No tools available</p>;
  }

  return (
    <div className="space-y-1">
      <p className="text-xs font-medium text-muted-foreground mb-2">
        Available tools ({tools.length}):
      </p>
      <div className="flex flex-wrap gap-1 max-h-[200px] overflow-y-auto">
        {tools.map((tool) => (
          <span
            key={tool.name}
            className="inline-flex items-center gap-1 text-xs bg-muted px-2 py-0.5 rounded"
          >
            <Wrench className="h-3 w-3 opacity-70" />
            {tool.name}
          </span>
        ))}
      </div>
    </div>
  );
}

interface AgentDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Agent to edit. If null/undefined, creates a new agent */
  agent?: Agent | null;
  /** Agent type: 'agent' for internal agents with prompts, 'mcp_gateway' for external profiles */
  agentType?: "mcp_gateway" | "agent";
  /** Callback when viewing version history (internal agents only) */
  onViewVersionHistory?: (agent: Agent) => void;
  /** Callback when a new agent/profile is created (not called for updates) */
  onCreated?: (created: { id: string; name: string }) => void;
}

export function AgentDialog({
  open,
  onOpenChange,
  agent,
  agentType = "mcp_gateway",
  onViewVersionHistory,
  onCreated,
}: AgentDialogProps) {
  const { data: allInternalAgents = [] } = useInternalAgents();
  const createAgent = useCreateProfile();
  const updateAgent = useUpdateProfile();
  const syncDelegations = useSyncAgentDelegations();
  const { data: currentDelegations = [] } = useAgentDelegations(agent?.id);
  const { data: chatopsProviders = [] } = useChatOpsStatus();
  const { data: teams } = useQuery({
    queryKey: ["teams"],
    queryFn: async () => {
      const response = await archestraApiSdk.getTeams();
      return response.data || [];
    },
  });
  const { data: availableKeys = [] } = useLabelKeys();
  const { data: isProfileAdmin } = useHasPermissions({ profile: ["admin"] });
  const agentLabelsRef = useRef<ProfileLabelsRef>(null);

  // Form state
  const [name, setName] = useState("");
  const [userPrompt, setUserPrompt] = useState("");
  const [systemPrompt, setSystemPrompt] = useState("");
  const [selectedDelegationTargetIds, setSelectedDelegationTargetIds] =
    useState<string[]>([]);
  const [allowedChatops, setAllowedChatops] = useState<string[]>([]);
  const [assignedTeamIds, setAssignedTeamIds] = useState<string[]>([]);
  const [labels, setLabels] = useState<ProfileLabel[]>([]);
  const [considerContextUntrusted, setConsiderContextUntrusted] =
    useState(false);
  const [selectedAgentType, setSelectedAgentType] = useState<
    "mcp_gateway" | "agent"
  >(agentType);

  // Determine if this is an internal agent based on the selected type
  const isInternalAgent = selectedAgentType === "agent";

  // Available agents that can be delegated to (excluding self)
  const availableDelegationTargets = useMemo(() => {
    return allInternalAgents
      .filter((a) => a.id !== agent?.id)
      .map((a) => ({
        value: a.id,
        label: a.name,
      }));
  }, [allInternalAgents, agent?.id]);

  // Reset form when dialog opens/closes or agent changes
  useEffect(() => {
    if (open) {
      if (agent) {
        // Edit mode
        setName(agent.name);
        setUserPrompt(agent.userPrompt || "");
        setSystemPrompt(agent.systemPrompt || "");
        setSelectedAgentType(agent.agentType || "mcp_gateway");
        // Reset delegation targets - will be populated by the next useEffect when data loads
        setSelectedDelegationTargetIds([]);
        // Parse allowedChatops from agent
        const chatopsValue = agent.allowedChatops;
        if (Array.isArray(chatopsValue)) {
          setAllowedChatops(chatopsValue as string[]);
        } else {
          setAllowedChatops([]);
        }
        // Teams and labels
        const agentTeams = agent.teams as unknown as
          | Array<{ id: string; name: string }>
          | undefined;
        setAssignedTeamIds(agentTeams?.map((t) => t.id) || []);
        setLabels(agent.labels || []);
        setConsiderContextUntrusted(agent.considerContextUntrusted || false);
      } else {
        // Create mode - reset all fields
        setName("");
        setUserPrompt("");
        setSystemPrompt("");
        setSelectedDelegationTargetIds([]);
        setAllowedChatops([]);
        setAssignedTeamIds([]);
        setLabels([]);
        setConsiderContextUntrusted(false);
        setSelectedAgentType(agentType);
      }
    }
  }, [open, agent, agentType]);

  // Sync selectedDelegationTargetIds with currentDelegations when data loads
  const currentDelegationIds = currentDelegations.map((a) => a.id).join(",");
  const agentId = agent?.id;

  useEffect(() => {
    if (open && agentId && currentDelegationIds) {
      setSelectedDelegationTargetIds(
        currentDelegationIds.split(",").filter(Boolean),
      );
    }
  }, [open, agentId, currentDelegationIds]);

  // Non-admin users must select at least one team for external profiles
  const requiresTeamSelection =
    !isProfileAdmin && !isInternalAgent && assignedTeamIds.length === 0;
  const hasNoAvailableTeams = !teams || teams.length === 0;

  const handleSave = useCallback(async () => {
    const trimmedName = name.trim();
    const trimmedUserPrompt = userPrompt.trim();
    const trimmedSystemPrompt = systemPrompt.trim();

    if (!trimmedName) {
      toast.error("Name is required");
      return;
    }

    // Non-admin users must select at least one team for external profiles
    if (!isProfileAdmin && !isInternalAgent && assignedTeamIds.length === 0) {
      toast.error("Please select at least one team");
      return;
    }

    // Save any unsaved label before submitting
    const updatedLabels = agentLabelsRef.current?.saveUnsavedLabel() || labels;

    try {
      let savedAgentId: string;

      if (agent) {
        // Update existing agent
        const updated = await updateAgent.mutateAsync({
          id: agent.id,
          data: {
            name: trimmedName,
            agentType: selectedAgentType,
            ...(isInternalAgent && {
              userPrompt: trimmedUserPrompt || undefined,
              systemPrompt: trimmedSystemPrompt || undefined,
              allowedChatops,
            }),
            teams: assignedTeamIds,
            labels: updatedLabels,
            considerContextUntrusted,
          },
        });
        savedAgentId = updated?.id ?? agent.id;
        toast.success(
          isInternalAgent
            ? "Agent updated successfully"
            : "Profile updated successfully",
        );
      } else {
        // Create new agent
        const created = await createAgent.mutateAsync({
          name: trimmedName,
          agentType: selectedAgentType,
          ...(isInternalAgent && {
            userPrompt: trimmedUserPrompt || undefined,
            systemPrompt: trimmedSystemPrompt || undefined,
            allowedChatops,
          }),
          teams: assignedTeamIds,
          labels: updatedLabels,
          considerContextUntrusted,
        });
        savedAgentId = created?.id ?? "";
        toast.success(
          isInternalAgent
            ? "Agent created successfully"
            : "Profile created successfully",
        );
        // Notify parent about creation (for opening connection dialog, etc.)
        if (onCreated && created) {
          onCreated({ id: created.id, name: created.name });
        }
      }

      // Sync delegations
      if (savedAgentId && selectedDelegationTargetIds.length > 0) {
        await syncDelegations.mutateAsync({
          agentId: savedAgentId,
          targetAgentIds: selectedDelegationTargetIds,
        });
      } else if (savedAgentId && agent && currentDelegations.length > 0) {
        // Clear delegations if none selected but there were some before
        await syncDelegations.mutateAsync({
          agentId: savedAgentId,
          targetAgentIds: [],
        });
      }
    } catch (_error) {
      toast.error(
        isInternalAgent ? "Failed to save agent" : "Failed to save profile",
      );
    }
  }, [
    name,
    userPrompt,
    systemPrompt,
    allowedChatops,
    assignedTeamIds,
    labels,
    considerContextUntrusted,
    selectedAgentType,
    agent,
    isInternalAgent,
    isProfileAdmin,
    selectedDelegationTargetIds,
    currentDelegations.length,
    updateAgent,
    createAgent,
    syncDelegations,
    onCreated,
  ]);

  const handleClose = useCallback(() => {
    onOpenChange(false);
  }, [onOpenChange]);

  const configuredChatopsProviders = chatopsProviders.filter(
    (provider) => provider.configured,
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-5xl h-[90vh] flex flex-col"
        onInteractOutside={(e) => e.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>
            {agent
              ? isInternalAgent
                ? "Edit Agent"
                : "Edit Profile"
              : isInternalAgent
                ? "Create New Agent"
                : "Create New Profile"}
            {agent && isInternalAgent && onViewVersionHistory && (
              <Button
                variant="link"
                size="sm"
                onClick={() => {
                  onOpenChange(false);
                  onViewVersionHistory(agent);
                }}
                className="text-xs h-auto p-0 ml-2"
              >
                Version History
              </Button>
            )}
          </DialogTitle>
        </DialogHeader>

        <Tabs
          defaultValue="general"
          className="flex-1 flex flex-col min-h-0 overflow-hidden"
        >
          <TabsList className="h-auto w-full justify-start gap-4 rounded-none border-b border-border bg-transparent p-0">
            <TabsTrigger
              value="general"
              className="relative rounded-none border-none bg-transparent px-0 pb-3 pt-0 text-sm font-medium text-muted-foreground shadow-none transition-colors hover:text-foreground data-[state=active]:text-foreground data-[state=active]:shadow-none [&[data-state=active]]:after:absolute [&[data-state=active]]:after:bottom-0 [&[data-state=active]]:after:left-0 [&[data-state=active]]:after:right-0 [&[data-state=active]]:after:h-0.5 [&[data-state=active]]:after:bg-primary"
            >
              General
            </TabsTrigger>
            {isInternalAgent && (
              <TabsTrigger
                value="agent"
                className="relative rounded-none border-none bg-transparent px-0 pb-3 pt-0 text-sm font-medium text-muted-foreground shadow-none transition-colors hover:text-foreground data-[state=active]:text-foreground data-[state=active]:shadow-none [&[data-state=active]]:after:absolute [&[data-state=active]]:after:bottom-0 [&[data-state=active]]:after:left-0 [&[data-state=active]]:after:right-0 [&[data-state=active]]:after:h-0.5 [&[data-state=active]]:after:bg-primary"
              >
                Agent
              </TabsTrigger>
            )}
          </TabsList>

          {/* General Tab */}
          <TabsContent
            value="general"
            className="flex-1 overflow-y-auto space-y-4 pt-4 px-1"
          >
            {/* Name - Common */}
            <div className="space-y-2">
              <Label htmlFor="agentName">Name *</Label>
              <Input
                id="agentName"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={
                  isInternalAgent ? "Enter agent name" : "My AI Profile"
                }
                autoFocus
              />
            </div>

            {/* Type Selection */}
            <div className="space-y-2">
              <Label htmlFor="agentType">Type</Label>
              <Select
                value={selectedAgentType}
                onValueChange={(value: "mcp_gateway" | "agent") =>
                  setSelectedAgentType(value)
                }
              >
                <SelectTrigger id="agentType" className="w-[200px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="mcp_gateway">MCP Gateway</SelectItem>
                  <SelectItem value="agent">Agent</SelectItem>
                </SelectContent>
              </Select>
              {isInternalAgent && (
                <p className="text-sm text-muted-foreground">
                  Agents can be used in chat with prompts and ChatOps
                  integrations.
                </p>
              )}
            </div>

            {/* Team Access - Common */}
            <div className="space-y-2">
              <Label>
                Team
                {!isProfileAdmin && !isInternalAgent && (
                  <span className="text-destructive ml-1">(required)</span>
                )}
              </Label>
              <MultiSelectCombobox
                options={
                  teams?.map((team) => ({
                    value: team.id,
                    label: team.name,
                  })) || []
                }
                value={assignedTeamIds}
                onChange={setAssignedTeamIds}
                placeholder={
                  hasNoAvailableTeams
                    ? "No teams available"
                    : assignedTeamIds.length === 0
                      ? "Add teams... Only Admins can access agents without teams"
                      : "Search teams..."
                }
                emptyMessage="No teams found."
              />
            </div>

            {/* Labels - Common */}
            <ProfileLabels
              ref={agentLabelsRef}
              labels={labels}
              onLabelsChange={setLabels}
              availableKeys={availableKeys}
            />

            {/* Consider Context Untrusted - Common */}
            <div className="flex items-center space-x-2">
              <Checkbox
                id="consider-context-untrusted"
                checked={considerContextUntrusted}
                onCheckedChange={(checked) =>
                  setConsiderContextUntrusted(checked === true)
                }
              />
              <div className="grid gap-1">
                <Label
                  htmlFor="consider-context-untrusted"
                  className="text-sm font-medium cursor-pointer"
                >
                  Treat user context as untrusted
                </Label>
                <p className="text-sm text-muted-foreground">
                  Enable when user prompts may contain untrusted and sensitive
                  data.
                </p>
              </div>
            </div>

            {/* Internal Agent Only - ChatOps */}
            {isInternalAgent && configuredChatopsProviders.length > 0 && (
              <div className="space-y-2">
                <Label>ChatOps Integrations</Label>
                <p className="text-sm text-muted-foreground">
                  Select which chat platforms can trigger this agent
                </p>
                {configuredChatopsProviders.map((provider) => (
                  <div
                    key={provider.id}
                    className="flex items-center space-x-2"
                  >
                    <Checkbox
                      id={`chatops-${provider.id}`}
                      checked={allowedChatops.includes(provider.id)}
                      onCheckedChange={(checked) => {
                        if (checked) {
                          setAllowedChatops([...allowedChatops, provider.id]);
                        } else {
                          setAllowedChatops(
                            allowedChatops.filter((id) => id !== provider.id),
                          );
                        }
                      }}
                    />
                    <Label
                      htmlFor={`chatops-${provider.id}`}
                      className="cursor-pointer font-normal"
                    >
                      {provider.displayName}
                    </Label>
                  </div>
                ))}
              </div>
            )}

            {/* Tools Section */}
            <div className="space-y-2">
              <Label>Tools</Label>
              <div className="flex flex-wrap items-center gap-2">
                {agent ? (
                  <ChatToolsDisplay agentId={agent.id} readOnly />
                ) : (
                  <p className="text-sm text-muted-foreground">
                    Tools can be assigned after creation.
                  </p>
                )}
              </div>
            </div>

            {/* Delegated Agents Section */}
            <div className="space-y-2">
              <Label>Delegated Agents</Label>
              <p className="text-sm text-muted-foreground">
                Other agents this {isInternalAgent ? "agent" : "profile"} can
                delegate tasks to
              </p>
              <div className="flex flex-wrap items-center gap-2">
                {/* Selected delegations (both current and newly added) */}
                {selectedDelegationTargetIds.map((delegateAgentId) => {
                  const targetAgent = allInternalAgents.find(
                    (a) => a.id === delegateAgentId,
                  );
                  const isExisting = currentDelegations.some(
                    (d) => d.id === delegateAgentId,
                  );
                  return (
                    <HoverCard
                      key={delegateAgentId}
                      openDelay={200}
                      closeDelay={100}
                    >
                      <HoverCardTrigger asChild>
                        <Button
                          variant="outline"
                          size="sm"
                          className={`h-7 px-2 gap-1.5 text-xs ${!isExisting ? "border-dashed" : ""}`}
                        >
                          {!isExisting && (
                            <span className="h-2 w-2 rounded-full bg-green-500" />
                          )}
                          <Bot className="h-3 w-3" />
                          <span>{targetAgent?.name || delegateAgentId}</span>
                        </Button>
                      </HoverCardTrigger>
                      <HoverCardContent className="w-80" align="start">
                        <div className="space-y-2">
                          <div className="flex items-center justify-between">
                            <h4 className="text-sm font-semibold">
                              {targetAgent?.name || delegateAgentId}
                            </h4>
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-6 w-6 p-0"
                              onClick={() =>
                                setSelectedDelegationTargetIds(
                                  selectedDelegationTargetIds.filter(
                                    (id) => id !== delegateAgentId,
                                  ),
                                )
                              }
                            >
                              <X className="h-4 w-4" />
                            </Button>
                          </div>
                          <p className="text-xs text-muted-foreground">
                            {isExisting
                              ? "Current delegation"
                              : "New delegation (will be saved)"}
                          </p>
                          <AgentToolsList agentId={delegateAgentId} />
                        </div>
                      </HoverCardContent>
                    </HoverCard>
                  );
                })}

                {/* Add agents dropdown */}
                {availableDelegationTargets.filter(
                  (a) => !selectedDelegationTargetIds.includes(a.value),
                ).length > 0 && (
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-8 px-2 gap-1.5 text-xs border-dashed"
                      >
                        <Bot className="h-3 w-3" />
                        <span>Add agent</span>
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="start">
                      {availableDelegationTargets
                        .filter(
                          (a) => !selectedDelegationTargetIds.includes(a.value),
                        )
                        .map((targetOption) => (
                          <DropdownMenuItem
                            key={targetOption.value}
                            onClick={() =>
                              setSelectedDelegationTargetIds([
                                ...selectedDelegationTargetIds,
                                targetOption.value,
                              ])
                            }
                          >
                            <Bot className="h-3 w-3 mr-2" />
                            {targetOption.label}
                          </DropdownMenuItem>
                        ))}
                    </DropdownMenuContent>
                  </DropdownMenu>
                )}
              </div>
              {selectedDelegationTargetIds.length === 0 &&
                availableDelegationTargets.length === 0 && (
                  <p className="text-sm text-muted-foreground">
                    No other agents available to delegate to.
                  </p>
                )}
            </div>
          </TabsContent>

          {/* Agent Tab (Internal Agents Only) */}
          {isInternalAgent && (
            <TabsContent
              value="agent"
              className="flex-1 overflow-y-auto space-y-4 pt-4 px-1"
            >
              <div className="space-y-2">
                <Label htmlFor="systemPrompt">System Prompt</Label>
                <Textarea
                  id="systemPrompt"
                  value={systemPrompt}
                  onChange={(e) => setSystemPrompt(e.target.value)}
                  placeholder="Enter system prompt (instructions for the LLM)"
                  className="min-h-[150px] font-mono"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="userPrompt">User Prompt</Label>
                <Textarea
                  id="userPrompt"
                  value={userPrompt}
                  onChange={(e) => setUserPrompt(e.target.value)}
                  placeholder="Enter user prompt (shown to user, sent to LLM)"
                  className="min-h-[150px] font-mono"
                />
              </div>
            </TabsContent>
          )}
        </Tabs>

        <DialogFooter className="mt-4">
          <Button variant="outline" onClick={handleClose}>
            Cancel
          </Button>
          <Button
            onClick={handleSave}
            disabled={
              !name.trim() ||
              createAgent.isPending ||
              updateAgent.isPending ||
              requiresTeamSelection ||
              (!isProfileAdmin && !isInternalAgent && hasNoAvailableTeams)
            }
          >
            {(createAgent.isPending || updateAgent.isPending) && (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            )}
            {agent ? "Update" : "Create"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
