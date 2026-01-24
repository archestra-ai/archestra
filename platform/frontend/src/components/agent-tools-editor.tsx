"use client";

import type { archestraApiTypes } from "@shared";
import { useQueries } from "@tanstack/react-query";
import { ExternalLink, Loader2, X } from "lucide-react";
import {
  forwardRef,
  Suspense,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  useAllProfileTools,
  useAssignTool,
  useUnassignTool,
} from "@/lib/agent-tools.query";
import {
  fetchCatalogTools,
  useCatalogTools,
  useInternalMcpCatalog,
} from "@/lib/internal-mcp-catalog.query";
import { useMcpServersGroupedByCatalog } from "@/lib/mcp-server.query";
import { cn } from "@/lib/utils";
import { DYNAMIC_CREDENTIAL_VALUE, TokenSelect } from "./token-select";

type InternalMcpCatalogItem =
  archestraApiTypes.GetInternalMcpCatalogResponses["200"][number];
type AgentTool =
  archestraApiTypes.GetAllAgentToolsResponses["200"]["data"][number];
type CatalogTool =
  archestraApiTypes.GetInternalMcpCatalogToolsResponses["200"][number];

// Pending changes for a single catalog item
interface PendingCatalogChanges {
  selectedToolIds: Set<string>;
  credentialSourceId: string | null;
  catalogItem: InternalMcpCatalogItem;
}

export interface AgentToolsEditorRef {
  saveChanges: (agentId?: string) => Promise<void>;
}

interface AgentToolsEditorProps {
  agentId?: string;
  searchQuery?: string;
  showAll?: boolean;
  onShowMore?: () => void;
  onSelectedCountChange?: (count: number) => void;
}

export const AgentToolsEditor = forwardRef<
  AgentToolsEditorRef,
  AgentToolsEditorProps
>(function AgentToolsEditor(
  {
    agentId,
    searchQuery = "",
    showAll = false,
    onShowMore,
    onSelectedCountChange,
  },
  ref,
) {
  return (
    <Suspense
      fallback={
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="h-3 w-3 animate-spin" />
          <span>Loading tools...</span>
        </div>
      }
    >
      <AgentToolsEditorContent
        agentId={agentId}
        searchQuery={searchQuery}
        showAll={showAll}
        onShowMore={onShowMore}
        onSelectedCountChange={onSelectedCountChange}
        ref={ref}
      />
    </Suspense>
  );
});

const AgentToolsEditorContent = forwardRef<
  AgentToolsEditorRef,
  AgentToolsEditorProps
>(function AgentToolsEditorContent(
  {
    agentId,
    searchQuery = "",
    showAll = false,
    onShowMore,
    onSelectedCountChange,
  },
  ref,
) {
  const assignTool = useAssignTool();
  const unassignTool = useUnassignTool();

  // Fetch catalog items (MCP servers in registry)
  const { data: catalogItems = [] } = useInternalMcpCatalog();

  // Fetch tool counts for all catalog items to enable sorting
  const toolCountQueries = useQueries({
    queries: catalogItems.map((catalog) => ({
      queryKey: ["mcp-catalog", catalog.id, "tools"] as const,
      queryFn: () => fetchCatalogTools(catalog.id),
    })),
  });

  // Create a map of catalog ID to tool count
  const toolCountByCatalog = useMemo(() => {
    const map = new Map<string, number>();
    for (let i = 0; i < catalogItems.length; i++) {
      const query = toolCountQueries[i];
      const catalog = catalogItems[i];
      if (catalog) {
        const tools = query?.data as CatalogTool[] | undefined;
        map.set(catalog.id, tools?.length ?? 0);
      }
    }
    return map;
  }, [catalogItems, toolCountQueries]);

  // Fetch assigned tools for this agent (only when editing existing agent)
  const { data: assignedToolsData } = useAllProfileTools({
    filters: { agentId: agentId ?? "" },
    skipPagination: true,
    enabled: !!agentId,
  });

  // Group assigned tools by catalogId
  const assignedToolsByCatalog = useMemo(() => {
    const map = new Map<string, AgentTool[]>();
    for (const at of assignedToolsData?.data ?? []) {
      const catalogId = at.tool.catalogId ?? at.tool.mcpServerCatalogId;
      if (!catalogId) continue;
      if (!map.has(catalogId)) map.set(catalogId, []);
      map.get(catalogId)?.push(at);
    }
    return map;
  }, [assignedToolsData]);

  // Sort catalog items: assigned tools first (by count desc), then servers with tools, then 0 tools
  const sortedCatalogItems = useMemo(() => {
    return [...catalogItems].sort((a, b) => {
      const aAssigned = assignedToolsByCatalog.get(a.id)?.length ?? 0;
      const bAssigned = assignedToolsByCatalog.get(b.id)?.length ?? 0;

      // Items with assigned tools come first, sorted by assigned count descending
      if (aAssigned > 0 && bAssigned === 0) return -1;
      if (aAssigned === 0 && bAssigned > 0) return 1;
      if (aAssigned !== bAssigned) return bAssigned - aAssigned;

      // Among items with same assigned count, sort by total tools available
      const aCount = toolCountByCatalog.get(a.id) ?? 0;
      const bCount = toolCountByCatalog.get(b.id) ?? 0;
      if (aCount > 0 && bCount === 0) return -1;
      if (aCount === 0 && bCount > 0) return 1;

      // Finally, sort alphabetically by name
      return a.name.localeCompare(b.name);
    });
  }, [catalogItems, assignedToolsByCatalog, toolCountByCatalog]);

  // Filter by search query
  const filteredCatalogItems = useMemo(() => {
    if (!searchQuery.trim()) return sortedCatalogItems;
    const search = searchQuery.toLowerCase();
    return sortedCatalogItems.filter((c) =>
      c.name.toLowerCase().includes(search),
    );
  }, [sortedCatalogItems, searchQuery]);

  // Track pending changes for all catalogs
  const pendingChangesRef = useRef<Map<string, PendingCatalogChanges>>(
    new Map(),
  );

  // Calculate total selected count from pending changes
  const calculateTotalSelectedCount = useCallback(() => {
    let total = 0;
    for (const changes of pendingChangesRef.current.values()) {
      total += changes.selectedToolIds.size;
    }
    return total;
  }, []);

  // Register pending changes from a pill
  const registerPendingChanges = useCallback(
    (catalogId: string, changes: PendingCatalogChanges) => {
      pendingChangesRef.current.set(catalogId, changes);
      onSelectedCountChange?.(calculateTotalSelectedCount());
    },
    [calculateTotalSelectedCount, onSelectedCountChange],
  );

  // Clear pending changes for a catalog
  const clearPendingChanges = useCallback(
    (catalogId: string) => {
      pendingChangesRef.current.delete(catalogId);
      onSelectedCountChange?.(calculateTotalSelectedCount());
    },
    [calculateTotalSelectedCount, onSelectedCountChange],
  );

  // Expose saveChanges method to parent
  useImperativeHandle(ref, () => ({
    saveChanges: async (overrideAgentId?: string) => {
      const targetAgentId = overrideAgentId ?? agentId;
      if (!targetAgentId) return;

      const allChanges = Array.from(pendingChangesRef.current.entries());

      for (const [catalogId, changes] of allChanges) {
        const currentAssigned = assignedToolsByCatalog.get(catalogId) ?? [];
        const currentAssignedIds = new Set(
          currentAssigned.map((at) => at.tool.id),
        );

        const toAdd = [...changes.selectedToolIds].filter(
          (id) => !currentAssignedIds.has(id),
        );
        const toRemove = [...currentAssignedIds].filter(
          (id) => !changes.selectedToolIds.has(id),
        );

        const isLocal = changes.catalogItem.serverType === "local";

        // Remove tools (only for existing agents)
        for (const toolId of toRemove) {
          await unassignTool.mutateAsync({ agentId: targetAgentId, toolId });
        }

        // Add tools
        for (const toolId of toAdd) {
          await assignTool.mutateAsync({
            agentId: targetAgentId,
            toolId,
            credentialSourceMcpServerId: !isLocal
              ? changes.credentialSourceId
              : undefined,
            executionSourceMcpServerId: isLocal
              ? changes.credentialSourceId
              : undefined,
            useDynamicTeamCredential:
              changes.credentialSourceId === DYNAMIC_CREDENTIAL_VALUE,
          });
        }
      }

      // Clear all pending changes after save
      pendingChangesRef.current.clear();
    },
  }));

  if (catalogItems.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No MCP servers available in the catalog.
      </p>
    );
  }

  if (filteredCatalogItems.length === 0) {
    return <p className="text-sm text-muted-foreground">No matching tools.</p>;
  }

  // Apply show more limit (show all when searching)
  const shouldShowAll = showAll || !!searchQuery.trim();
  const visibleItems =
    shouldShowAll || filteredCatalogItems.length <= 10
      ? filteredCatalogItems
      : filteredCatalogItems.slice(0, 10);
  const hiddenCount = filteredCatalogItems.length - 10;

  return (
    <div className="flex flex-wrap gap-2">
      {visibleItems.map((catalog) => (
        <McpServerPill
          key={catalog.id}
          catalogItem={catalog}
          assignedTools={assignedToolsByCatalog.get(catalog.id) ?? []}
          onPendingChanges={registerPendingChanges}
          onClearPendingChanges={clearPendingChanges}
        />
      ))}
      {!shouldShowAll && hiddenCount > 0 && onShowMore && (
        <Button
          variant="outline"
          size="sm"
          className="h-8 px-3 text-xs border-dashed"
          onClick={onShowMore}
        >
          +{hiddenCount} more
        </Button>
      )}
      {/* Show "Install New MCP Server" when there's no "+N more" button */}
      {(shouldShowAll || hiddenCount <= 0) && (
        <Button
          variant="outline"
          size="sm"
          className="h-8 px-3 gap-1.5 text-xs border-dashed"
          asChild
        >
          <a href="/mcp-catalog/registry" target="_blank" rel="noopener">
            <span className="font-medium">Install New MCP Server</span>
            <ExternalLink className="h-3 w-3" />
          </a>
        </Button>
      )}
    </div>
  );
});

interface McpServerPillProps {
  catalogItem: InternalMcpCatalogItem;
  assignedTools: AgentTool[];
  onPendingChanges: (catalogId: string, changes: PendingCatalogChanges) => void;
  onClearPendingChanges: (catalogId: string) => void;
}

function McpServerPill({
  catalogItem,
  assignedTools,
  onPendingChanges,
  onClearPendingChanges,
}: McpServerPillProps) {
  const [open, setOpen] = useState(false);

  // Fetch tools for this catalog item
  const { data: allTools = [], isLoading: isLoadingTools } = useCatalogTools(
    catalogItem.id,
  );

  // Fetch available credentials for this catalog
  const credentials = useMcpServersGroupedByCatalog({
    catalogId: catalogItem.id,
  });
  const mcpServers = credentials?.[catalogItem.id] ?? [];

  // Get current credential source (from first assigned tool or first available credential)
  const currentCredentialSource =
    assignedTools[0]?.credentialSourceMcpServerId ??
    assignedTools[0]?.executionSourceMcpServerId ??
    mcpServers[0]?.id ??
    null;

  // Currently assigned tool IDs - use sorted string for stable comparison
  const currentAssignedToolIds = useMemo(
    () => new Set(assignedTools.map((at) => at.tool.id)),
    [assignedTools],
  );
  const currentAssignedToolIdsKey = useMemo(
    () => [...currentAssignedToolIds].sort().join(","),
    [currentAssignedToolIds],
  );

  // Local state for pending changes
  const [selectedCredential, setSelectedCredential] = useState<string | null>(
    currentCredentialSource,
  );
  const [selectedToolIds, setSelectedToolIds] = useState<Set<string>>(
    new Set(currentAssignedToolIds),
  );

  // Reset local state when assigned tools actually change (e.g., after save)
  useEffect(() => {
    setSelectedCredential(currentCredentialSource);
    // Reconstruct set from the stable key to avoid stale closure
    const ids = currentAssignedToolIdsKey
      ? currentAssignedToolIdsKey.split(",")
      : [];
    setSelectedToolIds(new Set(ids));
    onClearPendingChanges(catalogItem.id);
  }, [
    currentCredentialSource,
    currentAssignedToolIdsKey,
    onClearPendingChanges,
    catalogItem.id,
  ]);

  // Report pending changes to parent whenever local state changes
  useEffect(() => {
    onPendingChanges(catalogItem.id, {
      selectedToolIds,
      credentialSourceId: selectedCredential,
      catalogItem,
    });
  }, [selectedToolIds, selectedCredential, catalogItem, onPendingChanges]);

  // Check if there are pending changes for this catalog
  const hasPendingChanges = useMemo(() => {
    if (selectedToolIds.size !== currentAssignedToolIds.size) return true;
    for (const id of selectedToolIds) {
      if (!currentAssignedToolIds.has(id)) return true;
    }
    return false;
  }, [selectedToolIds, currentAssignedToolIds]);

  // Don't show MCP server if no credentials are available (except for builtin servers)
  if (catalogItem.serverType !== "builtin" && mcpServers.length === 0) {
    return null;
  }

  const hasAssignedTools = assignedTools.length > 0;
  const assignedCount = assignedTools.length;
  const totalCount = allTools.length;

  // Show credential selector for non-builtin servers that have credentials available
  const showCredentialSelector =
    catalogItem.serverType !== "builtin" && mcpServers.length > 0;

  return (
    <Popover open={open} onOpenChange={setOpen} modal>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className={cn(
            "h-8 px-3 gap-1.5 text-xs",
            (hasPendingChanges
              ? selectedToolIds.size === 0
              : !hasAssignedTools) && "border-dashed opacity-50",
            hasPendingChanges && "border-primary opacity-100",
          )}
        >
          <span className="font-medium">{catalogItem.name}</span>
          <span className="text-muted-foreground">
            ({hasPendingChanges ? selectedToolIds.size : assignedCount})
          </span>
        </Button>
      </PopoverTrigger>
      <PopoverContent
        className="w-[420px] max-h-[min(500px,70vh)] p-0 flex flex-col overflow-hidden"
        side="bottom"
        align="start"
        sideOffset={8}
        avoidCollisions
        collisionPadding={16}
      >
        <div className="p-4 border-b flex items-start justify-between gap-2 shrink-0">
          <div>
            <h4 className="font-semibold">{catalogItem.name}</h4>
            {catalogItem.description && (
              <p className="text-sm text-muted-foreground mt-1">
                {catalogItem.description}
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

        {/* Credential Selector */}
        {showCredentialSelector && (
          <div className="p-4 border-b space-y-2 shrink-0">
            <Label className="text-sm font-medium">Credential</Label>
            <TokenSelect
              catalogId={catalogItem.id}
              value={selectedCredential}
              onValueChange={setSelectedCredential}
              shouldSetDefaultValue={false}
            />
          </div>
        )}

        {/* Tool Checklist */}
        {isLoadingTools ? (
          <div className="p-4 flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            <span>Loading tools...</span>
          </div>
        ) : totalCount === 0 ? (
          <div className="p-4 text-sm text-muted-foreground">
            No tools available for this server.
          </div>
        ) : (
          <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
            <ToolChecklist
              tools={allTools}
              selectedToolIds={selectedToolIds}
              setSelectedToolIds={setSelectedToolIds}
            />
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}

interface ToolChecklistProps {
  tools: CatalogTool[];
  selectedToolIds: Set<string>;
  setSelectedToolIds: React.Dispatch<React.SetStateAction<Set<string>>>;
}

function ExpandableDescription({ description }: { description: string }) {
  const [expanded, setExpanded] = useState(false);
  const descriptionRef = useRef<HTMLDivElement>(null);
  const [isTruncated, setIsTruncated] = useState(false);

  // biome-ignore lint/correctness/useExhaustiveDependencies: re-check truncation when description changes
  useEffect(() => {
    const el = descriptionRef.current;
    if (el) {
      // Check if text is truncated (scrollHeight > clientHeight means overflow)
      setIsTruncated(el.scrollHeight > el.clientHeight);
    }
  }, [description]);

  return (
    <div className="text-xs text-muted-foreground mt-0.5">
      <div
        ref={descriptionRef}
        className={cn(!expanded && "line-clamp-2")}
        style={{ wordBreak: "break-word" }}
      >
        {description}
      </div>
      {isTruncated && !expanded && (
        <button
          type="button"
          className="text-primary hover:underline mt-0.5"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setExpanded(true);
          }}
        >
          Show more...
        </button>
      )}
      {expanded && (
        <button
          type="button"
          className="text-primary hover:underline mt-0.5"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setExpanded(false);
          }}
        >
          Show less
        </button>
      )}
    </div>
  );
}

function ToolChecklist({
  tools,
  selectedToolIds,
  setSelectedToolIds,
}: ToolChecklistProps) {
  const allSelected = tools.every((tool) => selectedToolIds.has(tool.id));
  const noneSelected = tools.every((tool) => !selectedToolIds.has(tool.id));
  const selectedCount = tools.filter((t) => selectedToolIds.has(t.id)).length;

  const handleToggle = (toolId: string) => {
    setSelectedToolIds((prev) => {
      const newSet = new Set(prev);
      if (newSet.has(toolId)) {
        newSet.delete(toolId);
      } else {
        newSet.add(toolId);
      }
      return newSet;
    });
  };

  const handleSelectAll = () => {
    setSelectedToolIds(new Set(tools.map((t) => t.id)));
  };

  const handleDeselectAll = () => {
    setSelectedToolIds(new Set());
  };

  return (
    <div className="flex flex-col min-h-0 flex-1">
      <div className="px-4 py-2 border-b flex items-center justify-between bg-muted/30 shrink-0">
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
      <div className="flex-1 min-h-0 overflow-y-auto">
        <div className="p-2 space-y-0.5">
          {tools.map((tool) => {
            // Extract tool name without MCP server prefix
            const toolName = tool.name.split("__").pop() ?? tool.name;
            const isSelected = selectedToolIds.has(tool.id);

            return (
              <label
                key={tool.id}
                htmlFor={`tool-${tool.id}`}
                className={cn(
                  "flex items-start gap-3 p-2 rounded-md transition-colors cursor-pointer",
                  isSelected ? "bg-primary/10" : "hover:bg-muted/50",
                )}
              >
                <Checkbox
                  id={`tool-${tool.id}`}
                  checked={isSelected}
                  onCheckedChange={() => handleToggle(tool.id)}
                  className="mt-0.5"
                />
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium">{toolName}</div>
                  {tool.description && (
                    <ExpandableDescription description={tool.description} />
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
