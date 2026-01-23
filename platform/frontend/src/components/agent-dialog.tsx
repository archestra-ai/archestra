"use client";

import type { archestraApiTypes } from "@shared";
import { archestraApiSdk } from "@shared";
import { useQuery } from "@tanstack/react-query";
import { Bot, Loader2, Search, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import {
  type ProfileLabel,
  ProfileLabels,
  type ProfileLabelsRef,
} from "@/components/agent-labels";
import {
  AgentToolsEditor,
  type AgentToolsEditorRef,
} from "@/components/agent-tools-editor";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MultiSelectCombobox } from "@/components/ui/multi-select-combobox";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  useCreateProfile,
  useInternalAgents,
  useUpdateProfile,
} from "@/lib/agent.query";
import {
  useAgentDelegations,
  useSyncAgentDelegations,
} from "@/lib/agent-tools.query";
import { useHasPermissions } from "@/lib/auth.query";
import { useChatProfileMcpTools } from "@/lib/chat.query";
import { useChatOpsStatus } from "@/lib/chatops.query";
import { useInternalMcpCatalog } from "@/lib/internal-mcp-catalog.query";

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
            {tool.name}
          </span>
        ))}
      </div>
    </div>
  );
}

// Single subagent pill with popover
interface SubagentPillProps {
  agent: Agent;
  isSelected: boolean;
  onToggle: (agentId: string) => void;
}

function SubagentPill({ agent, isSelected, onToggle }: SubagentPillProps) {
  const [open, setOpen] = useState(false);

  return (
    <Popover open={open} onOpenChange={setOpen} modal>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className={`h-8 px-3 gap-1.5 text-xs ${!isSelected ? "border-dashed" : ""}`}
        >
          {isSelected && <span className="h-2 w-2 rounded-full bg-green-500" />}
          <Bot className="h-3 w-3" />
          <span className="font-medium">{agent.name}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent
        className="w-[350px] p-0"
        side="bottom"
        align="start"
        sideOffset={8}
        avoidCollisions
      >
        <div className="p-4 border-b flex items-start justify-between gap-2">
          <div className="flex-1">
            <h4 className="font-semibold">{agent.name}</h4>
            {agent.systemPrompt && (
              <p className="text-sm text-muted-foreground mt-1 line-clamp-2">
                {agent.systemPrompt}
              </p>
            )}
          </div>
          <Button
            variant="ghost"
            size="sm"
            className="h-6 w-6 p-0 shrink-0"
            onClick={() => setOpen(false)}
          >
            <X className="h-4 w-4" />
          </Button>
        </div>

        <div className="p-4 border-b">
          <label
            htmlFor={`subagent-toggle-${agent.id}`}
            className="flex items-center gap-3 cursor-pointer"
          >
            <Checkbox
              id={`subagent-toggle-${agent.id}`}
              checked={isSelected}
              onCheckedChange={() => onToggle(agent.id)}
            />
            <span className="text-sm font-medium">
              {isSelected ? "Enabled as subagent" : "Enable as subagent"}
            </span>
          </label>
        </div>

        <div className="p-4">
          <AgentToolsList agentId={agent.id} />
        </div>
      </PopoverContent>
    </Popover>
  );
}

// Component to edit subagents (delegations)
interface SubagentsEditorProps {
  availableAgents: Agent[];
  selectedAgentIds: string[];
  onSelectionChange: (ids: string[]) => void;
  currentAgentId?: string;
  searchQuery: string;
  showAll: boolean;
  onShowMore: () => void;
}

function SubagentsEditor({
  availableAgents,
  selectedAgentIds,
  onSelectionChange,
  currentAgentId,
  searchQuery,
  showAll,
  onShowMore,
}: SubagentsEditorProps) {
  // Filter out current agent from available agents
  const filteredAgents = availableAgents.filter((a) => a.id !== currentAgentId);

  // Filter by search query
  const searchFilteredAgents = searchQuery.trim()
    ? filteredAgents.filter((a) =>
        a.name.toLowerCase().includes(searchQuery.toLowerCase()),
      )
    : filteredAgents;

  // Apply show more limit (show all when searching)
  const shouldShowAll = showAll || !!searchQuery.trim();
  const visibleAgents =
    shouldShowAll || searchFilteredAgents.length <= 10
      ? searchFilteredAgents
      : searchFilteredAgents.slice(0, 10);
  const hiddenCount = searchFilteredAgents.length - 10;

  const handleToggle = (agentId: string) => {
    if (selectedAgentIds.includes(agentId)) {
      onSelectionChange(selectedAgentIds.filter((id) => id !== agentId));
    } else {
      onSelectionChange([...selectedAgentIds, agentId]);
    }
  };

  if (filteredAgents.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No other agents available.
      </p>
    );
  }

  if (searchFilteredAgents.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">No matching agents.</p>
    );
  }

  return (
    <>
      {visibleAgents.map((agent) => (
        <SubagentPill
          key={agent.id}
          agent={agent}
          isSelected={selectedAgentIds.includes(agent.id)}
          onToggle={handleToggle}
        />
      ))}
      {!shouldShowAll && hiddenCount > 0 && (
        <Button
          variant="outline"
          size="sm"
          className="h-8 px-3 text-xs border-dashed"
          onClick={onShowMore}
        >
          +{hiddenCount} more
        </Button>
      )}
    </>
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
  const { data: catalogItems = [] } = useInternalMcpCatalog();
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
  const { data: isProfileAdmin } = useHasPermissions({ profile: ["admin"] });
  const agentLabelsRef = useRef<ProfileLabelsRef>(null);
  const agentToolsEditorRef = useRef<AgentToolsEditorRef>(null);

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
  const [subagentsSearch, setSubagentsSearch] = useState("");
  const [subagentsSearchOpen, setSubagentsSearchOpen] = useState(false);
  const [subagentsShowAll, setSubagentsShowAll] = useState(false);
  const [toolsSearch, setToolsSearch] = useState("");
  const [toolsSearchOpen, setToolsSearchOpen] = useState(false);
  const [toolsShowAll, setToolsShowAll] = useState(false);

  // Determine if this is an internal agent based on the selected type
  const isInternalAgent = selectedAgentType === "agent";

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
      // Reset search when dialog opens
      setSubagentsSearch("");
      setSubagentsSearchOpen(false);
      setSubagentsShowAll(false);
      setToolsSearch("");
      setToolsSearchOpen(false);
      setToolsShowAll(false);
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

      // Save tool changes FIRST (before agent update triggers refetch that clears pending changes)
      if (agent) {
        await agentToolsEditorRef.current?.saveChanges();
      }

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

        // Save tool changes with the new agent ID
        if (savedAgentId) {
          await agentToolsEditorRef.current?.saveChanges(savedAgentId);
        }

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

      // Close dialog on success
      onOpenChange(false);
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
    onOpenChange,
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
        className="max-w-5xl h-[90vh] flex flex-col overflow-hidden"
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

        <div className="-mr-6 pr-6 flex-1 overflow-y-auto space-y-6 py-4">
          {/* Main Section */}
          <div className="rounded-lg border bg-card p-4 space-y-4">
            {/* Name */}
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

            {/* Tools */}
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <Label>Tools</Label>
                {catalogItems.length > 10 &&
                  (toolsSearchOpen ? (
                    <div className="relative flex-1 max-w-[200px]">
                      <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3 w-3 text-muted-foreground" />
                      <Input
                        placeholder="Search..."
                        value={toolsSearch}
                        onChange={(e) => setToolsSearch(e.target.value)}
                        className="h-7 pl-7 text-xs"
                        autoFocus
                        onBlur={() => {
                          if (!toolsSearch) {
                            setToolsSearchOpen(false);
                          }
                        }}
                      />
                    </div>
                  ) : (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 w-6 p-0"
                      onClick={() => setToolsSearchOpen(true)}
                    >
                      <Search className="h-3.5 w-3.5 text-muted-foreground" />
                    </Button>
                  ))}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <AgentToolsEditor
                  ref={agentToolsEditorRef}
                  agentId={agent?.id}
                  searchQuery={toolsSearch}
                  showAll={toolsShowAll}
                  onShowMore={() => setToolsShowAll(true)}
                />
              </div>
            </div>

            {/* Subagents */}
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <Label>Subagents</Label>
                {allInternalAgents.filter((a) => a.id !== agent?.id).length >
                  10 &&
                  (subagentsSearchOpen ? (
                    <div className="relative flex-1 max-w-[200px]">
                      <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3 w-3 text-muted-foreground" />
                      <Input
                        placeholder="Search..."
                        value={subagentsSearch}
                        onChange={(e) => setSubagentsSearch(e.target.value)}
                        className="h-7 pl-7 text-xs"
                        autoFocus
                        onBlur={() => {
                          if (!subagentsSearch) {
                            setSubagentsSearchOpen(false);
                          }
                        }}
                      />
                    </div>
                  ) : (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 w-6 p-0"
                      onClick={() => setSubagentsSearchOpen(true)}
                    >
                      <Search className="h-3.5 w-3.5 text-muted-foreground" />
                    </Button>
                  ))}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <SubagentsEditor
                  availableAgents={allInternalAgents}
                  selectedAgentIds={selectedDelegationTargetIds}
                  onSelectionChange={setSelectedDelegationTargetIds}
                  currentAgentId={agent?.id}
                  searchQuery={subagentsSearch}
                  showAll={subagentsShowAll}
                  onShowMore={() => setSubagentsShowAll(true)}
                />
              </div>
            </div>

            {/* Mode */}
            <div className="space-y-2">
              <Label htmlFor="agentType">Mode</Label>
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
              <p className="text-sm text-muted-foreground">
                {isInternalAgent
                  ? "Agents can be used internally in Chat or externally via A2A webhook, email, or MS Teams."
                  : "MCP Gateway allows external agents to connect to MCP server tools using the MCP protocol."}
              </p>
            </div>
          </div>

          {/* Agent Settings Section (Internal Agents Only) */}
          {isInternalAgent && (
            <div className="rounded-lg border bg-card p-4 space-y-4">
              <h3 className="font-semibold">Agent Settings</h3>

              {/* System Prompt */}
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

              {/* User Prompt */}
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

              {/* Agent Trigger Rules */}
              {configuredChatopsProviders.length > 0 && (
                <div className="space-y-2">
                  <Label>Agent Trigger Rules</Label>
                  <div className="space-y-3 pt-1">
                    {configuredChatopsProviders.map((provider) => (
                      <div
                        key={provider.id}
                        className="flex items-center justify-between"
                      >
                        <div className="space-y-0.5">
                          <label
                            htmlFor={`chatops-${provider.id}`}
                            className="text-sm cursor-pointer"
                          >
                            {provider.displayName}
                          </label>
                          <p className="text-xs text-muted-foreground">
                            Allow this agent to be triggered via{" "}
                            {provider.displayName}
                          </p>
                        </div>
                        <Switch
                          id={`chatops-${provider.id}`}
                          checked={allowedChatops.includes(provider.id)}
                          onCheckedChange={(checked) => {
                            if (checked) {
                              setAllowedChatops([
                                ...allowedChatops,
                                provider.id,
                              ]);
                            } else {
                              setAllowedChatops(
                                allowedChatops.filter(
                                  (id) => id !== provider.id,
                                ),
                              );
                            }
                          }}
                        />
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Additional Settings Section */}
          <div className="rounded-lg border bg-card p-4 space-y-4">
            <h3 className="font-semibold">Additional Settings</h3>

            {/* Team */}
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

            {/* Labels */}
            <ProfileLabels
              ref={agentLabelsRef}
              labels={labels}
              onLabelsChange={setLabels}
            />

            {/* Security */}
            <div className="space-y-2">
              <Label>Security</Label>
              <div className="flex items-center justify-between">
                <div className="space-y-0.5">
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
                <Switch
                  id="consider-context-untrusted"
                  checked={considerContextUntrusted}
                  onCheckedChange={setConsiderContextUntrusted}
                />
              </div>
            </div>
          </div>
        </div>

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
