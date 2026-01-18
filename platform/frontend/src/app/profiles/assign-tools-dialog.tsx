"use client";

import { ARCHESTRA_MCP_CATALOG_ID, type archestraApiTypes } from "@shared";
import {
  ChevronDown,
  ChevronRight,
  Filter,
  Loader2,
  Search,
  Server,
} from "lucide-react";
import Link from "next/link";
import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
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
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SearchableSelect } from "@/components/ui/searchable-select";
import {
  useAllProfileTools,
  useAssignTool,
  useProfileToolPatchMutation,
  useUnassignTool,
} from "@/lib/agent-tools.query";
import { useInternalMcpCatalog } from "@/lib/internal-mcp-catalog.query";
import { useTools } from "@/lib/tool.query";

interface AssignToolsDialogProps {
  agent: archestraApiTypes.GetAllAgentsResponses["200"][number];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function AssignToolsDialog({
  agent,
  open,
  onOpenChange,
}: AssignToolsDialogProps) {
  // Fetch all tools and filter for MCP tools (using non-suspense queries for dialog/portal)
  const { data: allTools, isLoading: isLoadingAllTools } = useTools({});
  const mcpTools = allTools?.filter((tool) => tool.catalogId !== null) || [];
  const { data: internalMcpCatalogItems, isLoading: isLoadingCatalog } =
    useInternalMcpCatalog();

  // Fetch currently assigned tools for this agent (use getAllProfileTools to get credentialSourceMcpServerId)
  // Use skipPagination to ensure all assigned tools are returned regardless of the default pagination limit
  // Use agentId filter to fetch only tools for this specific agent (more efficient than fetching all and filtering client-side)
  const { data: allProfileTools } = useAllProfileTools({
    skipPagination: true,
    filters: { agentId: agent.id },
  });
  const agentToolRelations = useMemo(
    () => allProfileTools?.data || [],
    [allProfileTools],
  );

  // Track selected tools with their credentials, execution source, and agent-tool IDs
  const [selectedTools, setSelectedTools] = useState<
    {
      toolId: string;
      credentialsSourceId?: string;
      executionSourceId?: string;
      agentToolId?: string;
      useDynamicTeamCredential?: boolean;
    }[]
  >([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [originFilter, setOriginFilter] = useState("all");
  const [showAssignedOnly, setShowAssignedOnly] = useState(false);

  // Track expanded tools
  const [expandedTools, setExpandedTools] = useState<Set<string>>(new Set());

  // Get unique origins from internal MCP catalog that have at least one tool
  const uniqueOrigins = useMemo(() => {
    // Get catalog IDs that have tools
    const catalogIdsWithTools = new Set(
      mcpTools.map((tool) => tool.catalogId).filter(Boolean),
    );

    const origins: { id: string; name: string }[] = [];
    internalMcpCatalogItems?.forEach((item) => {
      if (catalogIdsWithTools.has(item.id)) {
        origins.push({ id: item.id, name: item.name });
      }
    });
    return origins;
  }, [internalMcpCatalogItems, mcpTools]);

  // Get selected catalog item and determine if it's a local server
  const selectedCatalogItem = useMemo(() => {
    if (originFilter === "all") return null;
    return internalMcpCatalogItems?.find((item) => item.id === originFilter);
  }, [originFilter, internalMcpCatalogItems]);

  const isLocalServerForBulk = selectedCatalogItem?.serverType === "local";

  // Get set of assigned tool IDs for quick lookup
  const assignedToolIds = useMemo(
    () => new Set(agentToolRelations.map((at) => at.tool.id)),
    [agentToolRelations],
  );

  const filteredTools = useMemo(() => {
    let tools = mcpTools;

    // Filter by origin if not "all"
    if (originFilter !== "all") {
      tools = tools.filter((tool) => tool.catalogId === originFilter);
    }

    // Filter by search query
    if (searchQuery.trim()) {
      const query = searchQuery.toLowerCase();
      tools = tools.filter((tool) => tool.name.toLowerCase().includes(query));
    }

    // Filter by assigned-only if enabled
    if (showAssignedOnly) {
      tools = tools.filter((tool) => assignedToolIds.has(tool.id));
    }

    // Sort: assigned tools first, then alphabetically by name within each group
    return [...tools].sort((a, b) => {
      const aAssigned = assignedToolIds.has(a.id);
      const bAssigned = assignedToolIds.has(b.id);

      // If assignment status differs, assigned comes first
      if (aAssigned !== bAssigned) {
        return aAssigned ? -1 : 1;
      }

      // Within the same group, sort alphabetically by name
      return a.name.localeCompare(b.name);
    });
  }, [mcpTools, searchQuery, originFilter, assignedToolIds, showAssignedOnly]);

  // Initialize selected tools when agent tools load
  useEffect(() => {
    if (agentToolRelations) {
      setSelectedTools(
        agentToolRelations.map((at) => ({
          toolId: at.tool.id,
          credentialsSourceId: at.credentialSourceMcpServerId || undefined,
          executionSourceId: at.executionSourceMcpServerId || undefined,
          agentToolId: at.id,
          useDynamicTeamCredential: at.useDynamicTeamCredential || false,
        })),
      );
    }
  }, [agentToolRelations]);

  const assignTool = useAssignTool();
  const unassignTool = useUnassignTool();
  const patchProfileTool = useProfileToolPatchMutation();

  const isLoading = isLoadingAllTools || isLoadingCatalog;
  const isSaving =
    assignTool.isPending ||
    unassignTool.isPending ||
    patchProfileTool.isPending;

  const handleToggleTool = useCallback((toolId: string) => {
    setSelectedTools((prev) => {
      const isSelected = prev.some((t) => t.toolId === toolId);
      if (isSelected) {
        // Remove the tool
        return prev.filter((t) => t.toolId !== toolId);
      }
      // Add the tool
      return [...prev, { toolId, credentialsSourceId: undefined }];
    });
  }, []);

  const handleToggleExpand = useCallback((toolId: string) => {
    setExpandedTools((prev) => {
      const newSet = new Set(prev);
      if (newSet.has(toolId)) {
        newSet.delete(toolId);
      } else {
        newSet.add(toolId);
      }
      return newSet;
    });
  }, []);

  const handleCredentialsSourceChange = useCallback(
    (toolId: string, credentialsSourceId?: string) => {
      const isDynamic = credentialsSourceId === DYNAMIC_CREDENTIAL_VALUE;
      setSelectedTools((prev) => {
        return prev.map((tool) =>
          tool.toolId === toolId
            ? {
                ...tool,
                credentialsSourceId: isDynamic
                  ? undefined
                  : credentialsSourceId,
                useDynamicTeamCredential: isDynamic,
              }
            : tool,
        );
      });
    },
    [],
  );

  const handleExecutionSourceChange = useCallback(
    (toolId: string, executionSourceId?: string) => {
      const isDynamic = executionSourceId === DYNAMIC_CREDENTIAL_VALUE;
      setSelectedTools((prev) => {
        return prev.map((tool) =>
          tool.toolId === toolId
            ? {
                ...tool,
                executionSourceId: isDynamic ? undefined : executionSourceId,
                useDynamicTeamCredential: isDynamic,
              }
            : tool,
        );
      });
    },
    [],
  );

  // Handle bulk credential change for all visible tools
  const handleBulkCredentialChange = useCallback(
    (credentialId: string | null) => {
      if (!credentialId || originFilter === "all") return;

      const isDynamic = credentialId === DYNAMIC_CREDENTIAL_VALUE;

      // Get all visible tool IDs (filtered by current origin and search)
      const visibleToolIds = new Set(filteredTools.map((t) => t.id));

      setSelectedTools((prev) => {
        // Update credentials for visible tools that are selected
        const updated = prev.map((tool) => {
          if (!visibleToolIds.has(tool.toolId)) return tool;

          if (isLocalServerForBulk) {
            return {
              ...tool,
              executionSourceId: isDynamic ? undefined : credentialId,
              useDynamicTeamCredential: isDynamic,
            };
          }
          return {
            ...tool,
            credentialsSourceId: isDynamic ? undefined : credentialId,
            useDynamicTeamCredential: isDynamic,
          };
        });

        // Also add any visible tools that aren't yet selected
        const selectedToolIds = new Set(prev.map((t) => t.toolId));
        const newTools = filteredTools
          .filter((t) => !selectedToolIds.has(t.id))
          .map((t) => ({
            toolId: t.id,
            credentialsSourceId:
              isLocalServerForBulk || isDynamic ? undefined : credentialId,
            executionSourceId:
              isLocalServerForBulk && !isDynamic ? credentialId : undefined,
            useDynamicTeamCredential: isDynamic,
          }));

        return [...updated, ...newTools];
      });
    },
    [originFilter, filteredTools, isLocalServerForBulk],
  );

  // Helper to close dialog and reset filters
  const handleClose = useCallback(() => {
    setSearchQuery("");
    setOriginFilter("all");
    setShowAssignedOnly(false);
    setExpandedTools(new Set());
    onOpenChange(false);
  }, [onOpenChange]);

  const handleSave = useCallback(async () => {
    // Get current tool IDs and their state
    const currentToolIds = new Set(agentToolRelations.map((at) => at.tool.id));
    const selectedToolIds = new Set(selectedTools.map((t) => t.toolId));

    // Determine which tools to assign, unassign, and update
    const toAssign = selectedTools.filter(
      (tool) => !currentToolIds.has(tool.toolId),
    );
    const toUnassign = agentToolRelations.filter(
      (at) => !selectedToolIds.has(at.tool.id),
    );
    const toUpdate = selectedTools.filter((tool) => {
      if (!tool.agentToolId) return false;
      const current = agentToolRelations.find(
        (at) => at.tool.id === tool.toolId,
      );
      return (
        current &&
        (current.credentialSourceMcpServerId !==
          (tool.credentialsSourceId || null) ||
          current.executionSourceMcpServerId !==
            (tool.executionSourceId || null) ||
          current.useDynamicTeamCredential !==
            (tool.useDynamicTeamCredential || false))
      );
    });

    try {
      // Assign new tools
      for (const tool of toAssign) {
        await assignTool.mutateAsync({
          agentId: agent.id,
          toolId: tool.toolId,
          credentialSourceMcpServerId: tool.credentialsSourceId || null,
          executionSourceMcpServerId: tool.executionSourceId || null,
          useDynamicTeamCredential: tool.useDynamicTeamCredential || false,
        });
      }

      // Unassign removed tools
      for (const at of toUnassign) {
        await unassignTool.mutateAsync({
          agentId: agent.id,
          toolId: at.tool.id,
        });
      }

      // Update credentials and execution source for existing tools
      for (const tool of toUpdate) {
        if (tool.agentToolId) {
          await patchProfileTool.mutateAsync({
            id: tool.agentToolId,
            credentialSourceMcpServerId: tool.credentialsSourceId || null,
            executionSourceMcpServerId: tool.executionSourceId || null,
            useDynamicTeamCredential: tool.useDynamicTeamCredential || false,
          });
        }
      }

      toast.success(`Successfully updated tools for ${agent.name}`);

      handleClose();
    } catch (_error) {
      toast.error("Failed to update tool assignments");
    }
  }, [
    agent,
    agentToolRelations,
    assignTool,
    unassignTool,
    patchProfileTool,
    handleClose,
    selectedTools,
  ]);

  return (
    <Dialog
      open={open}
      onOpenChange={(newOpen) => {
        if (!newOpen) {
          handleClose();
        } else {
          onOpenChange(newOpen);
        }
      }}
    >
      <DialogContent className="max-w-2xl max-h-[80vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>Assign tools to {agent.name} profile</DialogTitle>
          <DialogDescription>
            Select which MCP server tools this profile can access.
          </DialogDescription>
          <p className="text-muted-foreground text-sm mt-2">
            Don't see the tool you need? Go to{" "}
            <Link
              href="/mcp-catalog/registry"
              className="text-primary underline"
            >
              MCP Registry
            </Link>{" "}
            to install an MCP server.
          </p>
        </DialogHeader>

        <div className="space-y-3">
          <SearchableSelect
            value={originFilter}
            onValueChange={setOriginFilter}
            placeholder="Filter by Origin"
            items={[
              { value: "all", label: "All Origins" },
              ...uniqueOrigins.map((origin) => ({
                value: origin.id,
                label: origin.name,
              })),
            ]}
            className="w-full"
          />

          <div className="flex gap-2">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                placeholder="Search tools by name..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-9"
              />
            </div>
            <Button
              variant={showAssignedOnly ? "default" : "outline"}
              size="sm"
              onClick={() => setShowAssignedOnly(!showAssignedOnly)}
              className="flex items-center gap-1.5 whitespace-nowrap h-9"
              title={showAssignedOnly ? "Show all tools" : "Show assigned only"}
            >
              <Filter className="h-4 w-4" />
              <span className="hidden sm:inline">Assigned</span>
              {showAssignedOnly && (
                <span className="text-xs bg-primary-foreground text-primary rounded-full px-1.5 py-0.5">
                  {assignedToolIds.size}
                </span>
              )}
            </Button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto pr-2 -mr-2">
          {isLoading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : mcpTools.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-8 text-center">
              <Server className="h-12 w-12 text-muted-foreground mb-2" />
              <p className="text-sm text-muted-foreground">
                No MCP server tools available.
              </p>
              <p className="text-xs text-muted-foreground mt-1">
                Install an MCP server to get started.
              </p>
            </div>
          ) : filteredTools.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-8 text-center">
              <Search className="mb-4 h-12 w-12 text-muted-foreground/50" />
              <h3 className="mb-2 text-lg font-semibold">No tools found</h3>
              <p className="text-sm text-muted-foreground">
                {showAssignedOnly && assignedToolIds.size === 0
                  ? "No tools are currently assigned to this profile."
                  : searchQuery || originFilter !== "all" || showAssignedOnly
                    ? "No tools match your filters. Try adjusting your search, origin, or assigned filter."
                    : "No tools available."}
              </p>
            </div>
          ) : (
            <div className="space-y-4">
              {filteredTools.map((tool) => {
                const isExpanded = expandedTools.has(tool.id);
                return (
                  <div
                    key={tool.id}
                    className="flex items-start space-x-3 rounded-lg border p-4 hover:bg-muted/50 transition-colors"
                  >
                    <Checkbox
                      id={`tool-${tool.id}`}
                      checked={selectedTools.some((t) => t.toolId === tool.id)}
                      onCheckedChange={() => handleToggleTool(tool.id)}
                      disabled={isSaving}
                    />
                    <div className="flex-1 space-y-1">
                      <div className="flex items-center gap-2">
                        <Label
                          htmlFor={`tool-${tool.id}`}
                          className="text-sm font-medium leading-none cursor-pointer mb-2 flex-1"
                        >
                          {tool.name}
                        </Label>
                        {tool.description && (
                          <button
                            type="button"
                            onClick={() => handleToggleExpand(tool.id)}
                            className="text-muted-foreground hover:text-foreground transition-colors"
                          >
                            {isExpanded ? (
                              <ChevronDown className="h-4 w-4" />
                            ) : (
                              <ChevronRight className="h-4 w-4" />
                            )}
                          </button>
                        )}
                      </div>
                      {selectedTools.some((t) => t.toolId === tool.id) &&
                        (() => {
                          const mcpCatalogItem = internalMcpCatalogItems?.find(
                            (item) => item.id === tool.catalogId,
                          );
                          const catalogId = tool.catalogId ?? "";
                          const isLocalServer =
                            mcpCatalogItem?.serverType === "local";
                          const selectedTool = selectedTools.find(
                            (t) => t.toolId === tool.id,
                          );

                          // Don't show credential selector for built-in Archestra tools
                          const isBuiltinArchestraTool =
                            tool.catalogId === ARCHESTRA_MCP_CATALOG_ID;
                          if (isBuiltinArchestraTool) {
                            return null;
                          }

                          // Determine value to show - use dynamic constant if useDynamicTeamCredential is true
                          const displayValue =
                            selectedTool?.useDynamicTeamCredential
                              ? DYNAMIC_CREDENTIAL_VALUE
                              : isLocalServer
                                ? selectedTool?.executionSourceId
                                : selectedTool?.credentialsSourceId;

                          return (
                            <div className="flex flex-col gap-1 mt-4">
                              <span className="text-xs text-muted-foreground">
                                Credential to use:
                              </span>
                              <Suspense
                                fallback={
                                  <Loader2 className="h-4 w-4 animate-spin" />
                                }
                              >
                                <TokenSelect
                                  catalogId={catalogId}
                                  onValueChange={(credentialSourceId) =>
                                    isLocalServer
                                      ? handleExecutionSourceChange(
                                          tool.id,
                                          credentialSourceId ?? undefined,
                                        )
                                      : handleCredentialsSourceChange(
                                          tool.id,
                                          credentialSourceId ?? undefined,
                                        )
                                  }
                                  value={displayValue ?? undefined}
                                  className="mb-4"
                                  shouldSetDefaultValue
                                />
                              </Suspense>
                            </div>
                          );
                        })()}
                      {isExpanded && tool.description && (
                        <p className="text-sm text-muted-foreground whitespace-pre-line">
                          {tool.description}
                        </p>
                      )}
                      <div className="flex items-center gap-2 text-xs text-muted-foreground">
                        <Server className="h-3 w-3" />
                        <span>MCP Server Tool</span>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {originFilter !== "all" &&
          originFilter !== ARCHESTRA_MCP_CATALOG_ID &&
          filteredTools.length > 0 && (
            <div className="pt-4 border-t">
              <Label className="text-md font-medium mb-1">
                Bulk assign credential
              </Label>
              <p className="text-xs text-muted-foreground mb-2">
                Select a credential to apply to all {filteredTools.length}{" "}
                visible tool{filteredTools.length !== 1 ? "s" : ""}
              </p>
              <TokenSelect
                catalogId={originFilter}
                onValueChange={handleBulkCredentialChange}
                value={undefined}
                className="w-full"
                shouldSetDefaultValue={false}
              />
            </div>
          )}

        <DialogFooter>
          <Button variant="outline" onClick={handleClose} disabled={isSaving}>
            Cancel
          </Button>
          <Button
            onClick={handleSave}
            disabled={
              isLoading ||
              isSaving ||
              selectedTools.some(function isMissingCredentials(tool) {
                // If using dynamic credential, it's valid
                if (tool.useDynamicTeamCredential) return false;

                const mcpTool = mcpTools.find((t) => t.id === tool.toolId);
                const mcpCatalogItem = internalMcpCatalogItems?.find(
                  (item) => item.id === mcpTool?.catalogId,
                );
                // Tools without a catalog item can't have credentials configured - skip validation
                if (!mcpCatalogItem) {
                  return false;
                }

                // Built-in Archestra tools don't require credentials
                if (mcpTool?.catalogId === ARCHESTRA_MCP_CATALOG_ID) {
                  return false;
                }

                const isLocalServer = mcpCatalogItem.serverType === "local";
                return isLocalServer
                  ? !tool.executionSourceId
                  : !tool.credentialsSourceId;
              })
            }
          >
            {isSaving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Save Changes
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
