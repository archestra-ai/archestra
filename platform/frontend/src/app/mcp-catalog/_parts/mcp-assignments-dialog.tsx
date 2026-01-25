"use client";

import {
  type archestraApiTypes,
  MCP_SERVER_TOOL_NAME_SEPARATOR,
} from "@shared";
import { Loader2, Search, X } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { toast } from "sonner";
import {
  DYNAMIC_CREDENTIAL_VALUE,
  TokenSelect,
} from "@/components/token-select";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { useProfilesQuery } from "@/lib/agent.query";
import {
  useAllProfileTools,
  useBulkAssignTools,
  useProfileToolPatchMutation,
  useUnassignTool,
} from "@/lib/agent-tools.query";
import { useCatalogTools } from "@/lib/internal-mcp-catalog.query";
import { useMcpServersGroupedByCatalog } from "@/lib/mcp-server.query";
import { cn } from "@/lib/utils";

type CatalogTool =
  archestraApiTypes.GetInternalMcpCatalogToolsResponses["200"][number];
type AgentTool =
  archestraApiTypes.GetAllAgentToolsResponses["200"]["data"][number];
type Profile = archestraApiTypes.GetAllAgentsResponses["200"][number];

// Pending changes for a profile
interface PendingChanges {
  selectedToolIds: Set<string>;
  credentialId: string | null;
}

interface McpAssignmentsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  catalogId: string;
  serverName: string;
  isBuiltin: boolean;
}

export function McpAssignmentsDialog({
  open,
  onOpenChange,
  catalogId,
  serverName,
  isBuiltin,
}: McpAssignmentsDialogProps) {
  // Fetch all tools for this MCP server
  const { data: allTools = [], isLoading: isLoadingTools } =
    useCatalogTools(catalogId);

  // Fetch assignments for this server
  const { data: assignedToolsData, isLoading: isLoadingAssignments } =
    useAllProfileTools({
      skipPagination: true,
      enabled: allTools.length > 0,
    });

  // Filter assignments to only those belonging to this catalog's tools
  const assignmentsForCatalog = useMemo(() => {
    if (!assignedToolsData?.data) return [];
    return assignedToolsData.data.filter((at) => {
      const toolCatalogId = at.tool.catalogId ?? at.tool.mcpServerCatalogId;
      return toolCatalogId === catalogId;
    });
  }, [assignedToolsData, catalogId]);

  // Fetch all profiles
  const { data: allProfiles = [], isLoading: isLoadingProfiles } =
    useProfilesQuery();

  // Fetch available credentials for this catalog
  const credentials = useMcpServersGroupedByCatalog({ catalogId });
  const mcpServers = credentials?.[catalogId] ?? [];

  // Determine if this is a local server
  const isLocalServer = mcpServers[0]?.serverType === "local";

  // Group assignments by profile
  const assignmentsByProfile = useMemo(() => {
    const map = new Map<
      string,
      { tools: AgentTool[]; credentialId: string | null }
    >();

    for (const at of assignmentsForCatalog) {
      const profileId = at.agent.id;
      if (!map.has(profileId)) {
        map.set(profileId, {
          tools: [],
          credentialId: at.useDynamicTeamCredential
            ? DYNAMIC_CREDENTIAL_VALUE
            : (at.credentialSourceMcpServerId ??
              at.executionSourceMcpServerId ??
              null),
        });
      }
      map.get(profileId)?.tools.push(at);
    }

    return map;
  }, [assignmentsForCatalog]);

  // Track pending changes for all profiles
  const [pendingChanges, setPendingChanges] = useState<
    Map<string, PendingChanges>
  >(new Map());
  const [isSaving, setIsSaving] = useState(false);
  const [mcpGatewaysSearch, setMcpGatewaysSearch] = useState("");
  const [mcpGatewaysSearchOpen, setMcpGatewaysSearchOpen] = useState(false);
  const [mcpGatewaysShowAll, setMcpGatewaysShowAll] = useState(false);
  const [agentsSearch, setAgentsSearch] = useState("");
  const [agentsSearchOpen, setAgentsSearchOpen] = useState(false);
  const [agentsShowAll, setAgentsShowAll] = useState(false);

  const unassignTool = useUnassignTool();
  const bulkAssign = useBulkAssignTools();
  const patchTool = useProfileToolPatchMutation();

  // Update pending changes for a profile
  const updatePendingChanges = useCallback(
    (profileId: string, changes: PendingChanges) => {
      setPendingChanges((prev) => {
        const next = new Map(prev);
        next.set(profileId, changes);
        return next;
      });
    },
    [],
  );

  // Check if there are any pending changes
  const hasAnyChanges = useMemo(() => {
    for (const [profileId, changes] of pendingChanges) {
      const current = assignmentsByProfile.get(profileId);
      const currentIds = new Set(current?.tools.map((t) => t.tool.id) ?? []);
      const currentCredential = current?.credentialId ?? null;

      // Check tool changes
      if (changes.selectedToolIds.size !== currentIds.size) return true;
      for (const id of changes.selectedToolIds) {
        if (!currentIds.has(id)) return true;
      }

      // Check credential changes (only if there are existing assignments)
      if (currentIds.size > 0 && changes.credentialId !== currentCredential) {
        return true;
      }
    }
    return false;
  }, [pendingChanges, assignmentsByProfile]);

  // Save all pending changes
  const handleSaveAll = async () => {
    setIsSaving(true);
    try {
      for (const [profileId, changes] of pendingChanges) {
        const current = assignmentsByProfile.get(profileId);
        const currentIds = new Set(current?.tools.map((t) => t.tool.id) ?? []);
        const currentCredential = current?.credentialId ?? null;

        const toAdd = [...changes.selectedToolIds].filter(
          (id) => !currentIds.has(id),
        );
        const toRemove = [...currentIds].filter(
          (id) => !changes.selectedToolIds.has(id),
        );

        const useDynamicCredential =
          changes.credentialId === DYNAMIC_CREDENTIAL_VALUE;

        // Remove tools
        for (const toolId of toRemove) {
          await unassignTool.mutateAsync({
            agentId: profileId,
            toolId,
          });
        }

        // Add new tools
        if (toAdd.length > 0) {
          const assignments = toAdd.map((toolId) => ({
            agentId: profileId,
            toolId,
            credentialSourceMcpServerId:
              !isLocalServer && !useDynamicCredential
                ? changes.credentialId
                : null,
            executionSourceMcpServerId:
              isLocalServer && !useDynamicCredential
                ? changes.credentialId
                : null,
            useDynamicTeamCredential: useDynamicCredential,
          }));

          await bulkAssign.mutateAsync({ assignments });
        }

        // Update credential for existing tools if it changed
        if (
          changes.credentialId !== currentCredential &&
          current?.tools.length &&
          toRemove.length === 0
        ) {
          const toolsToUpdate = current.tools.filter(
            (at) => !toRemove.includes(at.tool.id),
          );
          for (const at of toolsToUpdate) {
            await patchTool.mutateAsync({
              id: at.id,
              credentialSourceMcpServerId:
                !isLocalServer && !useDynamicCredential
                  ? changes.credentialId
                  : null,
              executionSourceMcpServerId:
                isLocalServer && !useDynamicCredential
                  ? changes.credentialId
                  : null,
              useDynamicTeamCredential: useDynamicCredential,
            });
          }
        }
      }

      toast.success("Changes saved");
      setPendingChanges(new Map());
      onOpenChange(false);
    } catch (error) {
      console.error("Failed to save changes:", error);
      toast.error("Failed to save changes");
    } finally {
      setIsSaving(false);
    }
  };

  // Reset pending changes when dialog closes
  const handleOpenChange = (newOpen: boolean) => {
    if (!newOpen) {
      setPendingChanges(new Map());
      setMcpGatewaysSearch("");
      setMcpGatewaysSearchOpen(false);
      setMcpGatewaysShowAll(false);
      setAgentsSearch("");
      setAgentsSearchOpen(false);
      setAgentsShowAll(false);
    }
    onOpenChange(newOpen);
  };

  const isLoading = isLoadingTools || isLoadingAssignments || isLoadingProfiles;

  // Split profiles into two groups: Profiles (MCP) and Agents
  const { mcpProfiles, agents } = useMemo(() => {
    const mcp: Profile[] = [];
    const agent: Profile[] = [];
    for (const profile of allProfiles) {
      if (profile.agentType === "agent") {
        agent.push(profile);
      } else {
        mcp.push(profile);
      }
    }
    // Sort each group: assigned first, unassigned last
    const sortByAssignments = (a: Profile, b: Profile) => {
      const aCount = assignmentsByProfile.get(a.id)?.tools.length ?? 0;
      const bCount = assignmentsByProfile.get(b.id)?.tools.length ?? 0;
      return bCount - aCount;
    };
    mcp.sort(sortByAssignments);
    agent.sort(sortByAssignments);
    return { mcpProfiles: mcp, agents: agent };
  }, [allProfiles, assignmentsByProfile]);

  // Filter profiles by search
  const filteredMcpProfiles = useMemo(() => {
    if (!mcpGatewaysSearch.trim()) return mcpProfiles;
    const search = mcpGatewaysSearch.toLowerCase();
    return mcpProfiles.filter((p) => p.name.toLowerCase().includes(search));
  }, [mcpProfiles, mcpGatewaysSearch]);

  const filteredAgents = useMemo(() => {
    if (!agentsSearch.trim()) return agents;
    const search = agentsSearch.toLowerCase();
    return agents.filter((a) => a.name.toLowerCase().includes(search));
  }, [agents, agentsSearch]);

  const renderProfilePills = (
    profiles: Profile[],
    showAll: boolean,
    onShowMore: () => void,
  ) => {
    const visibleProfiles =
      showAll || profiles.length <= 10 ? profiles : profiles.slice(0, 10);
    const hiddenCount = profiles.length - 10;

    return (
      <div className="flex flex-wrap gap-2">
        {visibleProfiles.map((profile) => {
          const assignment = assignmentsByProfile.get(profile.id);
          const pending = pendingChanges.get(profile.id);
          return (
            <ProfileAssignmentPill
              key={profile.id}
              profile={profile}
              assignedTools={assignment?.tools ?? []}
              allTools={allTools}
              catalogId={catalogId}
              isBuiltin={isBuiltin}
              currentCredentialId={assignment?.credentialId ?? null}
              pendingChanges={pending}
              onPendingChanges={updatePendingChanges}
            />
          );
        })}
        {!showAll && hiddenCount > 0 && (
          <Button
            variant="outline"
            size="sm"
            className="h-8 px-3 text-xs border-dashed"
            onClick={onShowMore}
          >
            +{hiddenCount} more
          </Button>
        )}
      </div>
    );
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-2xl max-h-[80vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>{serverName} - Assignments</DialogTitle>
          <DialogDescription>
            Manage which profiles have access to tools from this MCP server
          </DialogDescription>
        </DialogHeader>

        {isLoading ? (
          <div className="flex items-center justify-center py-8 gap-2 text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            <span>Loading...</span>
          </div>
        ) : (
          <>
            <div className="flex-1 overflow-y-auto space-y-4">
              {/* MCP Gateways Section */}
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <Label className="text-sm font-medium">MCP Gateways</Label>
                  {mcpProfiles.length > 10 &&
                    (mcpGatewaysSearchOpen ? (
                      <div className="relative flex-1 max-w-[200px]">
                        <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3 w-3 text-muted-foreground" />
                        <Input
                          placeholder="Search..."
                          value={mcpGatewaysSearch}
                          onChange={(e) => setMcpGatewaysSearch(e.target.value)}
                          className="h-7 pl-7 text-xs"
                          autoFocus
                          onBlur={() => {
                            if (!mcpGatewaysSearch) {
                              setMcpGatewaysSearchOpen(false);
                            }
                          }}
                        />
                      </div>
                    ) : (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-6 w-6 p-0"
                        onClick={() => setMcpGatewaysSearchOpen(true)}
                      >
                        <Search className="h-3.5 w-3.5 text-muted-foreground" />
                      </Button>
                    ))}
                </div>
                {mcpProfiles.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    No MCP gateways available.
                  </p>
                ) : filteredMcpProfiles.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    No matching MCP gateways.
                  </p>
                ) : (
                  renderProfilePills(
                    filteredMcpProfiles,
                    mcpGatewaysShowAll || !!mcpGatewaysSearch,
                    () => setMcpGatewaysShowAll(true),
                  )
                )}
              </div>

              {/* Agents Section */}
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <Label className="text-sm font-medium">Agents</Label>
                  {agents.length > 10 &&
                    (agentsSearchOpen ? (
                      <div className="relative flex-1 max-w-[200px]">
                        <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3 w-3 text-muted-foreground" />
                        <Input
                          placeholder="Search..."
                          value={agentsSearch}
                          onChange={(e) => setAgentsSearch(e.target.value)}
                          className="h-7 pl-7 text-xs"
                          autoFocus
                          onBlur={() => {
                            if (!agentsSearch) {
                              setAgentsSearchOpen(false);
                            }
                          }}
                        />
                      </div>
                    ) : (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-6 w-6 p-0"
                        onClick={() => setAgentsSearchOpen(true)}
                      >
                        <Search className="h-3.5 w-3.5 text-muted-foreground" />
                      </Button>
                    ))}
                </div>
                {agents.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    No agents available.
                  </p>
                ) : filteredAgents.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    No matching agents.
                  </p>
                ) : (
                  renderProfilePills(
                    filteredAgents,
                    agentsShowAll || !!agentsSearch,
                    () => setAgentsShowAll(true),
                  )
                )}
              </div>
            </div>

            {/* Sticky Save Button */}
            <div className="pt-4 border-t mt-4">
              <Button
                onClick={handleSaveAll}
                disabled={!hasAnyChanges || isSaving}
                className="w-full"
              >
                {isSaving ? "Saving..." : "Save"}
              </Button>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

interface ProfileAssignmentPillProps {
  profile: Profile;
  assignedTools: AgentTool[];
  allTools: CatalogTool[];
  catalogId: string;
  isBuiltin: boolean;
  currentCredentialId: string | null;
  pendingChanges?: PendingChanges;
  onPendingChanges: (profileId: string, changes: PendingChanges) => void;
}

function ProfileAssignmentPill({
  profile,
  assignedTools,
  allTools,
  catalogId,
  isBuiltin,
  currentCredentialId,
  pendingChanges,
  onPendingChanges,
}: ProfileAssignmentPillProps) {
  const [open, setOpen] = useState(false);

  // Use pending changes if available, otherwise use current state
  const selectedToolIds = useMemo(
    () =>
      pendingChanges?.selectedToolIds ??
      new Set(assignedTools.map((at) => at.tool.id)),
    [pendingChanges, assignedTools],
  );

  const credentialId = pendingChanges?.credentialId ?? currentCredentialId;

  // Fetch credentials for this catalog
  const credentials = useMcpServersGroupedByCatalog({ catalogId });
  const mcpServers = credentials?.[catalogId] ?? [];

  const currentAssignedIds = useMemo(
    () => new Set(assignedTools.map((at) => at.tool.id)),
    [assignedTools],
  );

  const hasChanges = useMemo(() => {
    if (selectedToolIds.size !== currentAssignedIds.size) return true;
    for (const id of selectedToolIds) {
      if (!currentAssignedIds.has(id)) return true;
    }
    if (assignedTools.length > 0 && credentialId !== currentCredentialId) {
      return true;
    }
    return false;
  }, [
    selectedToolIds,
    currentAssignedIds,
    credentialId,
    currentCredentialId,
    assignedTools.length,
  ]);

  const handleToolToggle = (newSelectedIds: Set<string>) => {
    onPendingChanges(profile.id, {
      selectedToolIds: newSelectedIds,
      credentialId: credentialId,
    });
  };

  const handleCredentialChange = (newCredentialId: string | null) => {
    onPendingChanges(profile.id, {
      selectedToolIds: selectedToolIds,
      credentialId: newCredentialId,
    });
  };

  const toolCount = selectedToolIds.size;
  const totalTools = allTools.length;
  const hasNoAssignments = toolCount === 0;
  const showCredentialSelector = !isBuiltin && mcpServers.length > 0;

  return (
    <Popover open={open} onOpenChange={setOpen} modal>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className={cn(
            "h-8 px-3 gap-1.5 text-xs",
            hasNoAssignments && "border-dashed",
            hasChanges && "border-primary",
          )}
        >
          <span className="font-medium">{profile.name}</span>
          <span className="text-muted-foreground">
            ({toolCount}/{totalTools})
          </span>
        </Button>
      </PopoverTrigger>
      <PopoverContent
        className="w-[420px] p-0"
        side="bottom"
        align="start"
        sideOffset={8}
        avoidCollisions
      >
        <div className="p-4 border-b flex items-start justify-between gap-2">
          <div>
            <h4 className="font-semibold">{profile.name}</h4>
            <p className="text-sm text-muted-foreground mt-1">
              Configure tool assignments for this profile
            </p>
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

        {/* Credential Selector */}
        {showCredentialSelector && (
          <div className="p-4 border-b space-y-2">
            <Label className="text-sm font-medium">Credential</Label>
            <TokenSelect
              catalogId={catalogId}
              value={credentialId}
              onValueChange={handleCredentialChange}
              shouldSetDefaultValue={hasNoAssignments && !pendingChanges}
            />
          </div>
        )}

        {/* Tool Checklist */}
        <ToolChecklist
          tools={allTools}
          selectedToolIds={selectedToolIds}
          onSelectionChange={handleToolToggle}
        />
      </PopoverContent>
    </Popover>
  );
}

interface ToolChecklistProps {
  tools: CatalogTool[];
  selectedToolIds: Set<string>;
  onSelectionChange: (selectedIds: Set<string>) => void;
}

function ToolChecklist({
  tools,
  selectedToolIds,
  onSelectionChange,
}: ToolChecklistProps) {
  const allSelected = tools.every((tool) => selectedToolIds.has(tool.id));
  const noneSelected = tools.every((tool) => !selectedToolIds.has(tool.id));
  const selectedCount = tools.filter((t) => selectedToolIds.has(t.id)).length;

  const handleToggle = (toolId: string) => {
    const newSet = new Set(selectedToolIds);
    if (newSet.has(toolId)) {
      newSet.delete(toolId);
    } else {
      newSet.add(toolId);
    }
    onSelectionChange(newSet);
  };

  const handleSelectAll = () => {
    onSelectionChange(new Set(tools.map((t) => t.id)));
  };

  const handleDeselectAll = () => {
    onSelectionChange(new Set());
  };

  const formatToolName = (toolName: string) => {
    const lastSeparator = toolName.lastIndexOf(MCP_SERVER_TOOL_NAME_SEPARATOR);
    if (lastSeparator !== -1) {
      return toolName.substring(lastSeparator + 2);
    }
    return toolName;
  };

  return (
    <div>
      <div className="px-4 py-2 border-b flex items-center justify-between bg-muted/30">
        <span className="text-xs text-muted-foreground">
          {selectedCount} of {tools.length} selected
        </span>
        <div className="flex gap-1">
          <Button
            variant="ghost"
            size="sm"
            className="text-xs h-6 px-2"
            onClick={handleSelectAll}
            disabled={allSelected}
          >
            Select All
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="text-xs h-6 px-2"
            onClick={handleDeselectAll}
            disabled={noneSelected}
          >
            Deselect All
          </Button>
        </div>
      </div>
      <div className="max-h-[250px] overflow-y-auto">
        <div className="p-2 space-y-0.5">
          {tools.map((tool) => {
            const toolName = formatToolName(tool.name);
            const isSelected = selectedToolIds.has(tool.id);

            return (
              <label
                key={tool.id}
                htmlFor={`tool-assign-${tool.id}`}
                className={cn(
                  "flex items-start gap-3 p-2 rounded-md transition-colors cursor-pointer",
                  isSelected ? "bg-primary/10" : "hover:bg-muted/50",
                )}
              >
                <Checkbox
                  id={`tool-assign-${tool.id}`}
                  checked={isSelected}
                  onCheckedChange={() => handleToggle(tool.id)}
                  className="mt-0.5"
                />
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium">{toolName}</div>
                  {tool.description && (
                    <div className="text-xs text-muted-foreground mt-0.5 line-clamp-2">
                      {tool.description}
                    </div>
                  )}
                </div>
              </label>
            );
          })}
        </div>
      </div>
    </div>
  );
}
