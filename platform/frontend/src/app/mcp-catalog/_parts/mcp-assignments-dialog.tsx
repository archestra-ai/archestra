"use client";

import { type archestraApiTypes, isPlaywrightCatalogItem } from "@shared";
import { Bot, Loader2, Pencil, X } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { toast } from "sonner";
import { ToolChecklist } from "@/components/agent-tools-editor";
import {
  DYNAMIC_CREDENTIAL_VALUE,
  TokenSelect,
} from "@/components/token-select";
import {
  AssignmentCombobox,
  type AssignmentComboboxItem,
} from "@/components/ui/assignment-combobox";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { useProfiles } from "@/lib/agent.query";
import { useInvalidateToolAssignmentQueries } from "@/lib/agent-tools.hook";
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
  const { data: allProfiles = [], isPending: isLoadingProfiles } =
    useProfiles();

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

  const invalidateAllQueries = useInvalidateToolAssignmentQueries();
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
    const affectedAgentIds = new Set<string>();

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
          isPlaywrightCatalogItem(catalogId) ||
          changes.credentialId === DYNAMIC_CREDENTIAL_VALUE;

        // Track affected agents for invalidation
        if (toAdd.length > 0 || toRemove.length > 0) {
          affectedAgentIds.add(profileId);
        }

        // Remove tools (skip invalidation, will do it once at the end)
        for (const toolId of toRemove) {
          await unassignTool.mutateAsync({
            agentId: profileId,
            toolId,
            skipInvalidation: true,
          });
        }

        // Add new tools (skip invalidation, will do it once at the end)
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

          await bulkAssign.mutateAsync({ assignments, skipInvalidation: true });
        }

        // Update credential for existing tools if it changed
        if (
          changes.credentialId !== currentCredential &&
          current?.tools.length &&
          toRemove.length === 0
        ) {
          affectedAgentIds.add(profileId);
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
              skipInvalidation: true,
            });
          }
        }
      }

      // Invalidate all queries once at the end
      invalidateAllQueries(affectedAgentIds);

      toast.success("Changes saved");
      setPendingChanges(new Map());
      onOpenChange(false);
    } catch (error) {
      console.error("Failed to save changes:", error);
      toast.error("Failed to save changes");
      // Still invalidate on error to ensure UI is in sync
      invalidateAllQueries(affectedAgentIds);
    } finally {
      setIsSaving(false);
    }
  };

  // Reset pending changes when dialog closes
  const handleOpenChange = (newOpen: boolean) => {
    if (!newOpen) {
      setPendingChanges(new Map());
    }
    onOpenChange(newOpen);
  };

  const isLoading = isLoadingTools || isLoadingAssignments || isLoadingProfiles;

  // Split profiles into two groups: Profiles (MCP) and Agents
  const { mcpProfiles, agents } = useMemo(() => {
    const mcp: Profile[] = [];
    const agent: Profile[] = [];
    for (const profile of allProfiles) {
      if (profile.agentType === "mcp_gateway") {
        mcp.push(profile);
      } else if (profile.agentType === "agent") {
        agent.push(profile);
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

  // Handle toggling a profile on/off from the combobox
  const handleProfileToggle = useCallback(
    (profileId: string) => {
      const pending = pendingChanges.get(profileId);
      const assignment = assignmentsByProfile.get(profileId);
      const currentlyHasTools = pending
        ? pending.selectedToolIds.size > 0
        : (assignment?.tools.length ?? 0) > 0;

      if (currentlyHasTools) {
        // Toggle OFF: clear all tools
        updatePendingChanges(profileId, {
          selectedToolIds: new Set(),
          credentialId:
            pending?.credentialId ?? assignment?.credentialId ?? null,
        });
      } else {
        // Toggle ON: pre-select all tools with default credential
        const allToolIds = new Set(allTools.map((t) => t.id));
        const defaultCredential =
          pending?.credentialId ??
          assignment?.credentialId ??
          mcpServers[0]?.id ??
          null;
        updatePendingChanges(profileId, {
          selectedToolIds: allToolIds,
          credentialId: defaultCredential,
        });
      }
    },
    [
      pendingChanges,
      assignmentsByProfile,
      allTools,
      mcpServers,
      updatePendingChanges,
    ],
  );

  // Build combobox items and selected IDs for each section
  const buildComboboxData = useCallback(
    (profiles: Profile[]) => {
      const items: AssignmentComboboxItem[] = profiles.map((p) => {
        const pending = pendingChanges.get(p.id);
        const assignment = assignmentsByProfile.get(p.id);
        const toolCount = pending
          ? pending.selectedToolIds.size
          : (assignment?.tools.length ?? 0);
        return {
          id: p.id,
          name: p.name,
          description: p.description || undefined,
          badge:
            toolCount > 0
              ? `${toolCount}/${allTools.length}`
              : `${allTools.length} tools`,
        };
      });

      const selectedIds = profiles
        .filter((p) => {
          const pending = pendingChanges.get(p.id);
          if (pending) return pending.selectedToolIds.size > 0;
          return (assignmentsByProfile.get(p.id)?.tools.length ?? 0) > 0;
        })
        .map((p) => p.id);

      return { items, selectedIds };
    },
    [pendingChanges, assignmentsByProfile, allTools],
  );

  const mcpCombobox = useMemo(
    () => buildComboboxData(mcpProfiles),
    [buildComboboxData, mcpProfiles],
  );
  const agentCombobox = useMemo(
    () => buildComboboxData(agents),
    [buildComboboxData, agents],
  );

  // Get selected profiles for pills
  const selectedMcpProfiles = useMemo(
    () => mcpProfiles.filter((p) => mcpCombobox.selectedIds.includes(p.id)),
    [mcpProfiles, mcpCombobox.selectedIds],
  );
  const selectedAgents = useMemo(
    () => agents.filter((a) => agentCombobox.selectedIds.includes(a.id)),
    [agents, agentCombobox.selectedIds],
  );

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
                <Label className="text-sm font-medium">MCP Gateways</Label>
                {mcpProfiles.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    No MCP gateways available.
                  </p>
                ) : (
                  <div className="flex flex-wrap gap-2">
                    {selectedMcpProfiles.map((profile) => {
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
                    <AssignmentCombobox
                      items={mcpCombobox.items}
                      selectedIds={mcpCombobox.selectedIds}
                      onToggle={handleProfileToggle}
                      placeholder="Search MCP gateways..."
                      emptyMessage="No MCP gateways found."
                      createAction={{
                        label: "Create New MCP Gateway",
                        href: "/mcp-gateways?create=true",
                      }}
                    />
                  </div>
                )}
              </div>

              {/* Agents Section */}
              <div className="space-y-2">
                <Label className="text-sm font-medium">Agents</Label>
                {agents.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    No agents available.
                  </p>
                ) : (
                  <div className="flex flex-wrap gap-2">
                    {selectedAgents.map((agent) => {
                      const assignment = assignmentsByProfile.get(agent.id);
                      const pending = pendingChanges.get(agent.id);
                      return (
                        <ProfileAssignmentPill
                          key={agent.id}
                          profile={agent}
                          assignedTools={assignment?.tools ?? []}
                          allTools={allTools}
                          catalogId={catalogId}
                          isBuiltin={isBuiltin}
                          currentCredentialId={assignment?.credentialId ?? null}
                          pendingChanges={pending}
                          onPendingChanges={updatePendingChanges}
                          showStatusDot
                        />
                      );
                    })}
                    <AssignmentCombobox
                      items={agentCombobox.items}
                      selectedIds={agentCombobox.selectedIds}
                      onToggle={handleProfileToggle}
                      placeholder="Search agents..."
                      emptyMessage="No agents found."
                      createAction={{
                        label: "Create New Agent",
                        href: "/agents?create=true",
                      }}
                    />
                  </div>
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
  showStatusDot?: boolean;
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
  showStatusDot,
}: ProfileAssignmentPillProps) {
  const [open, setOpen] = useState(false);
  const [changedInSession, setChangedInSession] = useState(false);

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
    setChangedInSession(true);
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
  const isPlaywright = isPlaywrightCatalogItem(catalogId);
  const showCredentialSelector =
    !isBuiltin && !isPlaywright && mcpServers.length > 0;

  return (
    <Popover
      open={open}
      onOpenChange={(v) => {
        setOpen(v);
        if (v) setChangedInSession(false);
      }}
      modal
    >
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className={cn(
            "h-8 px-3 gap-1.5 text-xs max-w-[250px]",
            hasNoAssignments && "border-dashed opacity-50",
            hasChanges && "border-primary",
          )}
        >
          {showStatusDot && !hasNoAssignments && (
            <span className="h-2 w-2 rounded-full bg-green-500 shrink-0" />
          )}
          {showStatusDot && <Bot className="h-3 w-3 shrink-0" />}
          <span className="font-medium truncate">{profile.name}</span>
          <span className="text-muted-foreground shrink-0">
            ({toolCount}/{totalTools})
          </span>
          <Pencil className="h-3 w-3 shrink-0 text-muted-foreground" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        className="w-[420px] max-h-[min(500px,var(--radix-popover-content-available-height))] p-0 flex flex-col overflow-hidden"
        side="bottom"
        align="start"
        sideOffset={8}
        avoidCollisions
        collisionPadding={16}
      >
        <div className="p-4 border-b flex items-start justify-between gap-2 shrink-0">
          <div className="flex-1 min-w-0">
            <h4 className="font-semibold truncate">{profile.name}</h4>
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
          <div className="p-4 border-b space-y-2 shrink-0">
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
        <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
          <ToolChecklist
            tools={allTools}
            selectedToolIds={selectedToolIds}
            onSelectionChange={handleToolToggle}
          />
        </div>

        {changedInSession && (
          <div className="p-2 border-t shrink-0">
            <Button size="sm" className="w-full" onClick={() => setOpen(false)}>
              OK
            </Button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
