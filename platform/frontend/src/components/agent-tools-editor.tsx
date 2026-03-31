"use client";

import {
  ARCHESTRA_MCP_CATALOG_ID,
  type archestraApiTypes,
  E2eTestId,
  getAgentToolCatalogPillTestId,
  isPlaywrightCatalogItem,
  parseFullToolName,
} from "@shared";
import { useQueries } from "@tanstack/react-query";
import { Loader2, Pencil, Search, X } from "lucide-react";
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  AssignmentCombobox,
  type AssignmentComboboxItem,
} from "@/components/ui/assignment-combobox";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { useInvalidateToolAssignmentQueries } from "@/lib/agent-tools.hook";
import {
  useAllProfileTools,
  useAssignTool,
  useProfileToolPatchMutation,
  useUnassignTool,
} from "@/lib/agent-tools.query";
import { useArchestraMcpIdentity } from "@/lib/mcp/archestra-mcp-server";
import {
  fetchCatalogTools,
  useCatalogTools,
  useInternalMcpCatalog,
} from "@/lib/mcp/internal-mcp-catalog.query";
import { useMcpServersGroupedByCatalog } from "@/lib/mcp/mcp-server.query";
import { cn } from "@/lib/utils";
import {
  getDefaultArchestraToolIds,
  sortAndFilterTools,
  sortCatalogItems,
} from "./agent-tools-editor.utils";
import { CatalogDocsLink } from "./catalog-docs-link";
import { McpCatalogIcon } from "./mcp-catalog-icon";
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
  /** When true, all tools should be selected once they load */
  selectAll?: boolean;
  /** Whether the catalog pill should remain visible. Only set to false when explicitly toggled off via combobox. */
  isActive?: boolean;
}

export interface AgentToolsEditorRef {
  saveChanges: (agentId?: string) => Promise<void>;
}

interface AgentToolsEditorProps {
  agentId?: string;
  onSelectedCountChange?: (count: number) => void;
  /** "pills" (default): compact pills + dropdown combobox. "cards": inline grid of MCP server cards. */
  layout?: "pills" | "cards";
}

export const AgentToolsEditor = forwardRef<
  AgentToolsEditorRef,
  AgentToolsEditorProps
>(function AgentToolsEditor(
  { agentId, onSelectedCountChange, layout = "pills" },
  ref,
) {
  return (
    <AgentToolsEditorContent
      agentId={agentId}
      onSelectedCountChange={onSelectedCountChange}
      layout={layout}
      ref={ref}
    />
  );
});

const AgentToolsEditorContent = forwardRef<
  AgentToolsEditorRef,
  AgentToolsEditorProps
>(function AgentToolsEditorContent(
  { agentId, onSelectedCountChange, layout = "pills" },
  ref,
) {
  const { catalogName } = useArchestraMcpIdentity();
  const invalidateAllQueries = useInvalidateToolAssignmentQueries();
  const assignTool = useAssignTool();
  const unassignTool = useUnassignTool();
  const patchTool = useProfileToolPatchMutation();

  // Fetch catalog items (MCP servers in registry)
  const { data: catalogItems = [], isPending } = useInternalMcpCatalog();

  // Fetch all credentials grouped by catalog (for default credential on toggle)
  const allCredentials = useMcpServersGroupedByCatalog();

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
      const catalogId = at.tool.catalogId;
      if (!catalogId) continue;
      if (!map.has(catalogId)) map.set(catalogId, []);
      map.get(catalogId)?.push(at);
    }
    return map;
  }, [assignedToolsData]);

  // Sort catalog items: assigned tools first (by count desc), then servers with tools, then 0 tools
  const sortedCatalogItems = useMemo(() => {
    return sortCatalogItems(
      catalogItems,
      (catalog) => assignedToolsByCatalog.get(catalog.id)?.length ?? 0,
      (catalog) => toolCountByCatalog.get(catalog.id) ?? 0,
    );
  }, [catalogItems, assignedToolsByCatalog, toolCountByCatalog]);

  // State counter to force re-renders when pendingChangesRef updates
  const [pendingVersion, setPendingVersion] = useState(0);

  // Track which catalog pill should auto-open its popover after being added
  const [autoOpenCatalogId, setAutoOpenCatalogId] = useState<string | null>(
    null,
  );

  // Track pending changes for all catalogs
  const pendingChangesRef = useRef<Map<string, PendingCatalogChanges>>(
    new Map(),
  );

  // Track whether default tools have been pre-selected for new agent creation
  const defaultToolsInitializedRef = useRef(false);

  // Pre-select default Archestra tools when creating a new agent (no agentId)
  useEffect(() => {
    if (agentId) return; // Only for new agent creation
    if (defaultToolsInitializedRef.current) return; // Only initialize once

    const toolsByCatalogIndex = toolCountQueries.map(
      (q) => (q?.data as CatalogTool[] | undefined) ?? undefined,
    );
    const result = getDefaultArchestraToolIds(
      catalogItems,
      toolsByCatalogIndex,
    );
    if (!result) return;

    const archestraCatalog = catalogItems[result.catalogIndex];
    if (!archestraCatalog) return;

    defaultToolsInitializedRef.current = true;
    pendingChangesRef.current.set(ARCHESTRA_MCP_CATALOG_ID, {
      selectedToolIds: result.toolIds,
      credentialSourceId: null,
      catalogItem: archestraCatalog,
      selectAll: false,
    });
    onSelectedCountChange?.(result.toolIds.size);
    setPendingVersion((v) => v + 1);
  }, [agentId, catalogItems, toolCountQueries, onSelectedCountChange]);

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
      setPendingVersion((v) => v + 1);
    },
    [calculateTotalSelectedCount, onSelectedCountChange],
  );

  // Clear pending changes for a catalog
  const clearPendingChanges = useCallback(
    (catalogId: string) => {
      pendingChangesRef.current.delete(catalogId);
      onSelectedCountChange?.(calculateTotalSelectedCount());
      setPendingVersion((v) => v + 1);
    },
    [calculateTotalSelectedCount, onSelectedCountChange],
  );

  // Expose saveChanges method to parent
  useImperativeHandle(ref, () => ({
    saveChanges: async (overrideAgentId?: string) => {
      const targetAgentId = overrideAgentId ?? agentId;
      if (!targetAgentId) return;

      const allChanges = Array.from(pendingChangesRef.current.entries());
      let hasChanges = false;

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

        if (toAdd.length > 0 || toRemove.length > 0) {
          hasChanges = true;
        }

        const _isLocal = changes.catalogItem.serverType === "local";
        const prefersEnterpriseManaged =
          changes.catalogItem.enterpriseManagedConfig != null;

        // Remove and add tools in parallel (skip invalidation, will do it once at the end)
        const useDynamicCredential =
          isPlaywrightCatalogItem(changes.catalogItem.id) ||
          changes.credentialSourceId === DYNAMIC_CREDENTIAL_VALUE;
        const useEnterpriseManagedCredential =
          prefersEnterpriseManaged && useDynamicCredential;

        const results = await Promise.allSettled([
          ...toRemove.map((toolId) =>
            unassignTool.mutateAsync({
              agentId: targetAgentId,
              toolId,
              skipInvalidation: true,
            }),
          ),
          ...toAdd.map((toolId) =>
            assignTool.mutateAsync({
              agentId: targetAgentId,
              toolId,
              mcpServerId:
                !useDynamicCredential && !useEnterpriseManagedCredential
                  ? changes.credentialSourceId
                  : undefined,
              resolveAtCallTime: useDynamicCredential,
              credentialResolutionMode: useEnterpriseManagedCredential
                ? "enterprise_managed"
                : useDynamicCredential
                  ? "dynamic"
                  : "static",
              skipInvalidation: true,
            }),
          ),
        ]);

        const failures = results.filter((r) => r.status === "rejected");
        if (failures.length > 0) {
          throw (failures[0] as PromiseRejectedResult).reason;
        }

        // Update credential on tools that remain assigned but whose credential changed
        const toKeep = currentAssigned.filter((at) =>
          changes.selectedToolIds.has(at.tool.id),
        );
        for (const agentTool of toKeep) {
          const currentCred =
            agentTool.credentialResolutionMode === "dynamic"
              ? DYNAMIC_CREDENTIAL_VALUE
              : agentTool.credentialResolutionMode === "enterprise_managed"
                ? DYNAMIC_CREDENTIAL_VALUE
                : (agentTool.mcpServerId ?? null);
          if (currentCred !== changes.credentialSourceId) {
            hasChanges = true;
            await patchTool.mutateAsync({
              id: agentTool.id,
              mcpServerId:
                !useDynamicCredential && !useEnterpriseManagedCredential
                  ? (changes.credentialSourceId ?? undefined)
                  : null,
              credentialResolutionMode: useEnterpriseManagedCredential
                ? "enterprise_managed"
                : useDynamicCredential
                  ? "dynamic"
                  : "static",
              skipInvalidation: true,
            });
          }
        }
      }

      // Invalidate all queries once at the end
      if (hasChanges) {
        invalidateAllQueries(targetAgentId);
      }

      // Clear all pending changes after save
      pendingChangesRef.current.clear();
    },
  }));

  // Compute which catalog IDs are "selected" (have tools assigned or pending)
  // biome-ignore lint/correctness/useExhaustiveDependencies: pendingVersion triggers re-computation when pendingChangesRef updates
  const selectedCatalogIds = useMemo(() => {
    const ids: string[] = [];
    for (const catalog of sortedCatalogItems) {
      const pending = pendingChangesRef.current.get(catalog.id);
      if (pending) {
        // Show the pill as long as it hasn't been explicitly toggled off via the combobox.
        // This keeps the pill visible when the user clicks "Deselect All" inside the popover.
        if (pending.isActive !== false) ids.push(catalog.id);
      } else {
        const assigned = assignedToolsByCatalog.get(catalog.id);
        if (assigned && assigned.length > 0) ids.push(catalog.id);
      }
    }
    return ids;
  }, [sortedCatalogItems, assignedToolsByCatalog, pendingVersion]);

  // Handle toggling a catalog on/off from the combobox
  const handleCatalogToggle = useCallback(
    (catalogId: string) => {
      const catalog = catalogItems.find((c) => c.id === catalogId);
      if (!catalog) return;

      const pending = pendingChangesRef.current.get(catalogId);
      const assigned = assignedToolsByCatalog.get(catalogId) ?? [];
      const currentlySelected = pending
        ? pending.isActive !== false
        : assigned.length > 0;

      if (currentlySelected) {
        // Toggle OFF: clear all tools and hide the pill
        registerPendingChanges(catalogId, {
          selectedToolIds: new Set(),
          credentialSourceId: pending?.credentialSourceId ?? null,
          catalogItem: catalog,
          selectAll: false,
          isActive: false,
        });
      } else {
        // Toggle ON: pre-select all tools using cached data
        const toolIdx = catalogItems.findIndex((c) => c.id === catalogId);
        const toolQuery = toolCountQueries[toolIdx];
        const tools = (toolQuery?.data as CatalogTool[] | undefined) ?? [];
        const allToolIds = new Set(tools.map((t) => t.id));

        // Get default credential
        const credentials = allCredentials?.[catalogId] ?? [];
        const defaultCredential = credentials[0]?.id ?? null;

        registerPendingChanges(catalogId, {
          selectedToolIds: allToolIds,
          credentialSourceId: pending?.credentialSourceId ?? defaultCredential,
          catalogItem: catalog,
          selectAll: true,
          isActive: true,
        });
      }
    },
    [
      catalogItems,
      assignedToolsByCatalog,
      toolCountQueries,
      allCredentials,
      registerPendingChanges,
    ],
  );

  // Build combobox items
  // biome-ignore lint/correctness/useExhaustiveDependencies: pendingVersion triggers re-computation when pendingChangesRef updates
  const comboboxItems: AssignmentComboboxItem[] = useMemo(() => {
    return sortedCatalogItems.map((catalog) => {
      const pending = pendingChangesRef.current.get(catalog.id);
      const assignedCount = pending
        ? pending.selectedToolIds.size
        : (assignedToolsByCatalog.get(catalog.id)?.length ?? 0);
      const totalCount = toolCountByCatalog.get(catalog.id) ?? 0;
      const hasNoTools = totalCount === 0;
      const hasNoCredentials =
        catalog.serverType !== "builtin" &&
        !allCredentials?.[catalog.id]?.length;
      const isDisabled = hasNoTools || hasNoCredentials;
      const displayName =
        catalog.id === ARCHESTRA_MCP_CATALOG_ID ? catalogName : catalog.name;
      return {
        id: catalog.id,
        name: displayName,
        description: catalog.description || undefined,
        sortRank: catalog.id === ARCHESTRA_MCP_CATALOG_ID ? 1 : 0,
        icon: (
          <McpCatalogIcon
            icon={catalog.icon}
            catalogId={catalog.id}
            size={16}
          />
        ),
        badge: isDisabled
          ? undefined
          : assignedCount > 0
            ? `${assignedCount}/${totalCount}`
            : `${totalCount} tools`,
        disabled: isDisabled,
        disabledReason: hasNoTools
          ? "Not installed"
          : hasNoCredentials
            ? "Not installed"
            : undefined,
      };
    });
  }, [
    sortedCatalogItems,
    assignedToolsByCatalog,
    toolCountByCatalog,
    allCredentials,
    pendingVersion,
  ]);

  // Filter to only selected catalogs for pills
  const selectedCatalogs = useMemo(() => {
    const selectedSet = new Set(selectedCatalogIds);
    return sortedCatalogItems.filter((c) => selectedSet.has(c.id));
  }, [sortedCatalogItems, selectedCatalogIds]);

  if (isPending) {
    return (
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Loader2 className="h-3 w-3 animate-spin" />
        <span>Loading tools...</span>
      </div>
    );
  }

  if (catalogItems.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No MCP servers available in the catalog.
      </p>
    );
  }

  if (layout === "cards") {
    return (
      <div className="grid grid-cols-3 gap-2">
        {sortedCatalogItems.map((catalog) => {
          const isSelected = selectedCatalogIds.includes(catalog.id);
          const pending = pendingChangesRef.current.get(catalog.id);
          const assignedCount = pending
            ? pending.selectedToolIds.size
            : (assignedToolsByCatalog.get(catalog.id)?.length ?? 0);
          const totalCount = toolCountByCatalog.get(catalog.id) ?? 0;
          const hasNoTools = totalCount === 0;
          const hasNoCredentials =
            catalog.serverType !== "builtin" &&
            !allCredentials?.[catalog.id]?.length;
          const isDisabled = hasNoTools || hasNoCredentials;

          return (
            <McpServerCard
              key={catalog.id}
              catalog={catalog}
              displayName={
                catalog.id === ARCHESTRA_MCP_CATALOG_ID
                  ? catalogName
                  : catalog.name
              }
              isSelected={isSelected}
              isDisabled={isDisabled}
              assignedCount={assignedCount}
              totalCount={totalCount}
              onToggle={() => handleCatalogToggle(catalog.id)}
            />
          );
        })}
      </div>
    );
  }

  return (
    <div className="flex flex-wrap gap-2">
      {selectedCatalogs.map((catalog) => (
        <McpServerPill
          key={catalog.id}
          catalogItem={catalog}
          displayName={
            catalog.id === ARCHESTRA_MCP_CATALOG_ID ? catalogName : catalog.name
          }
          assignedTools={assignedToolsByCatalog.get(catalog.id) ?? []}
          initialPendingChanges={pendingChangesRef.current.get(catalog.id)}
          onPendingChanges={registerPendingChanges}
          onClearPendingChanges={clearPendingChanges}
          onRemove={handleCatalogToggle}
          autoOpen={catalog.id === autoOpenCatalogId}
          onAutoOpened={() => setAutoOpenCatalogId(null)}
        />
      ))}
      <AssignmentCombobox
        items={comboboxItems}
        selectedIds={selectedCatalogIds}
        onToggle={handleCatalogToggle}
        onItemAdded={setAutoOpenCatalogId}
        placeholder="Search MCP servers..."
        emptyMessage="No MCP servers found."
        testId={E2eTestId.AgentToolsAddButton}
        createAction={{
          label: "Install New MCP Server",
          href: "/mcp/registry",
        }}
      />
    </div>
  );
});

function McpServerCard({
  catalog,
  displayName,
  isSelected,
  isDisabled,
  assignedCount,
  totalCount,
  onToggle,
}: {
  catalog: InternalMcpCatalogItem;
  displayName: string;
  isSelected: boolean;
  isDisabled: boolean;
  assignedCount: number;
  totalCount: number;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={isDisabled ? undefined : onToggle}
      disabled={isDisabled}
      className={cn(
        "flex flex-col items-center gap-1.5 rounded-lg border p-3 text-center transition-colors cursor-pointer",
        isSelected && "border-primary bg-primary/5",
        isDisabled && "opacity-40 cursor-not-allowed",
        !isSelected && !isDisabled && "hover:bg-accent",
      )}
    >
      <McpCatalogIcon icon={catalog.icon} catalogId={catalog.id} size={24} />
      <span className="text-xs font-medium truncate w-full">{displayName}</span>
      <span className="text-[10px] text-muted-foreground">
        {isDisabled
          ? "Not installed"
          : isSelected
            ? `${assignedCount}/${totalCount} tools`
            : `${totalCount} tools`}
      </span>
    </button>
  );
}

interface McpServerPillProps {
  catalogItem: InternalMcpCatalogItem;
  displayName: string;
  assignedTools: AgentTool[];
  initialPendingChanges?: PendingCatalogChanges;
  onPendingChanges: (catalogId: string, changes: PendingCatalogChanges) => void;
  onClearPendingChanges: (catalogId: string) => void;
  /** Called when the user clicks the remove button on the pill */
  onRemove: (catalogId: string) => void;
  /** When true, the pill's popover opens automatically after mount */
  autoOpen?: boolean;
  /** Called after the auto-open has been consumed */
  onAutoOpened?: () => void;
}

function McpServerPill({
  catalogItem,
  displayName,
  assignedTools,
  initialPendingChanges,
  onPendingChanges,
  onClearPendingChanges,
  onRemove,
  autoOpen,
  onAutoOpened,
}: McpServerPillProps) {
  const [open, setOpen] = useState(false);
  const [changedInSession, setChangedInSession] = useState(false);

  // Auto-open the popover when this pill was just added from the combobox
  useEffect(() => {
    if (autoOpen) {
      setOpen(true);
      onAutoOpened?.();
    }
  }, [autoOpen, onAutoOpened]);

  // Fetch tools for this catalog item
  const { data: allTools = [], isLoading: isLoadingTools } = useCatalogTools(
    catalogItem.id,
  );

  // Fetch available credentials for this catalog
  const credentials = useMcpServersGroupedByCatalog({
    catalogId: catalogItem.id,
  });
  const mcpServers = credentials?.[catalogItem.id] ?? [];
  const prefersEnterpriseManaged = catalogItem.enterpriseManagedConfig != null;

  const currentCredentialSource =
    assignedTools[0]?.credentialResolutionMode === "dynamic"
      ? DYNAMIC_CREDENTIAL_VALUE
      : assignedTools[0]?.credentialResolutionMode === "enterprise_managed"
        ? DYNAMIC_CREDENTIAL_VALUE
        : (assignedTools[0]?.mcpServerId ?? mcpServers[0]?.id ?? null);
  const _currentEnterpriseManagedConfig = null;

  // Currently assigned tool IDs - use sorted string for stable comparison
  const currentAssignedToolIds = useMemo(
    () => new Set(assignedTools.map((at) => at.tool.id)),
    [assignedTools],
  );
  const currentAssignedToolIdsKey = useMemo(
    () => [...currentAssignedToolIds].sort().join(","),
    [currentAssignedToolIds],
  );

  // Local state for pending changes — seed from parent's pending state if available
  const [selectedCredential, setSelectedCredential] = useState<string | null>(
    initialPendingChanges?.credentialSourceId ?? currentCredentialSource,
  );
  const [selectedToolIds, setSelectedToolIds] = useState<Set<string>>(
    initialPendingChanges?.selectedToolIds ?? new Set(currentAssignedToolIds),
  );

  // Track previous assigned tool IDs to detect actual changes (e.g., after save)
  // This avoids resetting state when unrelated props change (like credentials loading)
  const prevAssignedToolIdsKeyRef = useRef(currentAssignedToolIdsKey);

  // Reset local state only when assigned tools actually change (e.g., after save)
  // biome-ignore lint/correctness/useExhaustiveDependencies: only reset when assigned tools change, not when credentials or callbacks change
  useEffect(() => {
    if (currentAssignedToolIdsKey === prevAssignedToolIdsKeyRef.current) return;
    prevAssignedToolIdsKeyRef.current = currentAssignedToolIdsKey;
    setSelectedCredential(currentCredentialSource);
    const ids = currentAssignedToolIdsKey
      ? currentAssignedToolIdsKey.split(",")
      : [];
    setSelectedToolIds(new Set(ids));
    onClearPendingChanges(catalogItem.id);
  }, [currentAssignedToolIdsKey]);

  // Auto-select all tools when selectAll flag is set and tools finish loading.
  // Use a ref so auto-select only fires once (at mount) and doesn't fight user deselections.
  const pendingSelectAllRef = useRef(initialPendingChanges?.selectAll ?? false);
  useEffect(() => {
    if (!pendingSelectAllRef.current || allTools.length === 0) return;

    if (selectedToolIds.size === 0) {
      // Tools loaded but nothing selected — auto-select all
      setSelectedToolIds(new Set(allTools.map((t) => t.id)));
    }
    // Clear the flag regardless so we don't fight user deselections
    pendingSelectAllRef.current = false;
    // Depend on .size (not the full set) intentionally — the effect only cares
    // whether the selection is empty, and the ref guard prevents re-firing anyway.
  }, [selectedToolIds.size, allTools]);

  // Report pending changes to parent whenever local state changes.
  // The pill can only be rendered when isActive !== false, so always report as active
  // to avoid overwriting the parent's isActive flag with undefined.
  useEffect(() => {
    onPendingChanges(catalogItem.id, {
      selectedToolIds,
      credentialSourceId: selectedCredential,
      catalogItem,
      isActive: true,
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

  const assignedCount = assignedTools.length;
  const totalCount = allTools.length;
  const displayedCount = hasPendingChanges
    ? selectedToolIds.size
    : assignedCount;
  const isEmpty = displayedCount === 0;

  // Show credential selector for non-builtin, non-Playwright servers that have credentials available
  const isPlaywright = isPlaywrightCatalogItem(catalogItem.id);
  const showCredentialSelector =
    catalogItem.serverType !== "builtin" &&
    !isPlaywright &&
    mcpServers.length > 0;
  return (
    <Popover
      open={open}
      onOpenChange={(v) => {
        setOpen(v);
        if (v) setChangedInSession(false);
      }}
      modal
    >
      <div className="flex items-center">
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            size="sm"
            className={cn(
              "h-8 px-3 gap-1.5 text-xs",
              isEmpty && "border-dashed opacity-50",
              isEmpty && "rounded-r-none border-r-0",
              hasPendingChanges && "border-primary opacity-100",
            )}
            data-testid={getAgentToolCatalogPillTestId(catalogItem.name)}
          >
            <McpCatalogIcon
              icon={catalogItem.icon}
              catalogId={catalogItem.id}
              size={14}
            />
            <span className="font-medium">{displayName}</span>
            <span className="text-muted-foreground">({displayedCount})</span>
            <Pencil className="h-3 w-3 shrink-0 text-muted-foreground" />
          </Button>
        </PopoverTrigger>
        {isEmpty && (
          <Button
            variant="outline"
            size="sm"
            className="h-8 w-8 p-0 rounded-l-none border-dashed opacity-50 hover:opacity-100"
            onClick={(e) => {
              e.stopPropagation();
              onRemove(catalogItem.id);
            }}
            aria-label={`Remove ${catalogItem.name}`}
          >
            <X className="h-3 w-3" />
          </Button>
        )}
      </div>
      <PopoverContent
        className="w-[420px] max-h-[min(500px,var(--radix-popover-content-available-height))] p-0 flex flex-col overflow-hidden"
        side="bottom"
        align="start"
        sideOffset={8}
        avoidCollisions
        collisionPadding={16}
      >
        <div className="p-4 border-b flex items-start justify-between gap-2 shrink-0">
          <div>
            <h4 className="font-semibold">{displayName}</h4>
            {catalogItem.description && (
              <p className="text-sm text-muted-foreground mt-1">
                {catalogItem.description}
                {catalogItem.docsUrl ? (
                  <>
                    {" "}
                    <CatalogDocsLink
                      url={catalogItem.docsUrl}
                      className="inline-flex items-center gap-1 text-primary hover:underline"
                    />
                  </>
                ) : null}
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
            <Label className="text-sm font-medium">Connect on behalf of</Label>
            <p className="text-xs text-muted-foreground">
              Choose whether this tool uses a fixed server connection or
              resolves credentials for the current caller at runtime.
            </p>
            <TokenSelect
              catalogId={catalogItem.id}
              value={selectedCredential}
              onValueChange={setSelectedCredential}
              shouldSetDefaultValue={false}
              prefersEnterpriseManaged={prefersEnterpriseManaged}
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
              onSelectionChange={(ids) => {
                setSelectedToolIds(ids);
                setChangedInSession(true);
              }}
            />
          </div>
        )}

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

export interface ToolChecklistProps {
  tools: CatalogTool[];
  selectedToolIds: Set<string>;
  onSelectionChange: (selectedIds: Set<string>) => void;
}

function formatToolName(toolName: string) {
  return parseFullToolName(toolName).toolName || toolName;
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

export function ToolChecklist({
  tools,
  selectedToolIds,
  onSelectionChange,
}: ToolChecklistProps) {
  const [searchQuery, setSearchQuery] = useState("");

  // Snapshot the initial selection for sort order so tools don't jump
  // around as the user toggles checkboxes. Updates synchronously during
  // render when the selection transitions from empty to populated (async
  // data load), then stays frozen until remount.
  const initialSelectedRef = useRef(selectedToolIds);
  if (initialSelectedRef.current.size === 0 && selectedToolIds.size > 0) {
    initialSelectedRef.current = selectedToolIds;
  }
  // biome-ignore lint/correctness/useExhaustiveDependencies: selectedToolIds.size > 0 triggers re-sort when selection transitions from empty to populated
  const filteredTools = useMemo(
    () => sortAndFilterTools(tools, initialSelectedRef.current, searchQuery),
    [tools, searchQuery, selectedToolIds.size > 0],
  );

  const allSelected = filteredTools.every((tool) =>
    selectedToolIds.has(tool.id),
  );
  const noneSelected = filteredTools.every(
    (tool) => !selectedToolIds.has(tool.id),
  );
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
    const newSet = new Set(selectedToolIds);
    for (const tool of filteredTools) {
      newSet.add(tool.id);
    }
    onSelectionChange(newSet);
  };

  const handleDeselectAll = () => {
    const newSet = new Set(selectedToolIds);
    for (const tool of filteredTools) {
      newSet.delete(tool.id);
    }
    onSelectionChange(newSet);
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
      {tools.length > 5 && (
        <div className="px-4 py-2 border-b shrink-0">
          <div className="relative">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3 w-3 text-muted-foreground" />
            <Input
              placeholder="Search tools..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="h-7 pl-7 text-xs"
            />
          </div>
        </div>
      )}
      <div className="flex-1 min-h-0 overflow-y-auto">
        <div className="p-2 space-y-0.5">
          {filteredTools.length === 0 ? (
            <div className="text-center py-4 text-sm text-muted-foreground">
              No tools match your search
            </div>
          ) : (
            filteredTools.map((tool) => {
              const toolName = formatToolName(tool.name);
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
            })
          )}
        </div>
      </div>
    </div>
  );
}
