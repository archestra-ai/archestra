"use client";

import {
  type AgentScope,
  ARCHESTRA_MCP_CATALOG_ID,
  ARCHESTRA_TOOL_GROUPS,
  type archestraApiTypes,
  E2eTestId,
  getAgentToolCatalogPillTestId,
  isPlaywrightCatalogItem,
  parseFullToolName,
} from "@archestra/shared";
import { useQueryClient } from "@tanstack/react-query";
import {
  ChevronDown,
  ChevronRight,
  Loader2,
  Search,
  Server,
} from "lucide-react";
import Link from "next/link";
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { EmptyState } from "@/components/empty-state";
import { QueryLoadError } from "@/components/query-load-error";
import {
  AssignmentCombobox,
  type AssignmentComboboxItem,
} from "@/components/ui/assignment-combobox";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useInvalidateToolAssignmentQueries } from "@/lib/agent-tools.hook";
import { useBulkUpdateAgentTools } from "@/lib/agent-tools.query";
import { useProfileToolsWithIds } from "@/lib/chat/chat.query";
import { useFeature } from "@/lib/config/config.query";
import { useArchestraMcpIdentity } from "@/lib/mcp/archestra-mcp-server";
import {
  useCatalogTools,
  useInternalMcpCatalog,
} from "@/lib/mcp/internal-mcp-catalog.query";
import { useMcpServersGroupedByCatalog } from "@/lib/mcp/mcp-server.query";
import { useOrganization } from "@/lib/organization.query";
import { cn } from "@/lib/utils";
import {
  buildBulkToolUpdate,
  computeMcpEnvConflicts,
  credentialSourceOfAssignments,
  filterDefaultArchestraToolIds,
  getCatalogAssignmentGate,
  isCatalogInEnvironment,
  setsEqual,
  shouldResetCredentialPin,
  sortAndFilterTools,
  sortCatalogItems,
  summarizeBulkFailure,
} from "./agent-tools-editor.utils";
import { McpCatalogIcon } from "./mcp-catalog-icon";
import { McpServerPillShell } from "./mcp-server-pill-shell";
import { DYNAMIC_CREDENTIAL_VALUE, TokenSelect } from "./token-select";

type InternalMcpCatalogItem =
  archestraApiTypes.GetInternalMcpCatalogResponses["200"][number];
type CatalogTool =
  archestraApiTypes.GetInternalMcpCatalogToolsResponses["200"][number];

/**
 * Apps and built-in servers run in-process with no installed MCP server or stored
 * credentials, so the picker neither gates their assignment on an installed
 * server nor offers a credential selector for them.
 */
const isCredentialLessCatalogType = (
  serverType: InternalMcpCatalogItem["serverType"],
) => serverType === "builtin" || serverType === "app";
type ResourceTool = archestraApiTypes.GetAgentToolsResponses["200"][number];
type AssignedTool = {
  tool: ResourceTool;
  mcpServerId: string | null;
  credentialResolutionMode: "static" | "dynamic" | "enterprise_managed";
};

// Pending changes for a single catalog item
interface PendingCatalogChanges {
  selectedToolIds: Set<string>;
  credentialSourceId: string | null;
  catalogItem: InternalMcpCatalogItem;
  /** When true, all tools should be selected once they load */
  selectAll?: boolean;
  /**
   * When true, the creation-default subset should be selected once tools load.
   * Used when re-adding the built-in Archestra catalog so it lands on its
   * default tools (what a new agent gets), not all ~100+ tools.
   */
  selectDefaults?: boolean;
  /** Whether the catalog pill should remain visible. Only set to false when explicitly toggled off via combobox. */
  isActive?: boolean;
}

export type McpEnvConflict = { catalogId: string; name: string };

export interface AgentToolsEditorRef {
  saveChanges: (params?: {
    agentId?: string;
    resourceLabel?: string;
  }) => Promise<void>;
  /** Unselect every MCP catalog flagged as not belonging to the agent's environment. */
  removeIncompatibleTools: () => void;
}

interface AgentToolsEditorProps {
  agentId?: string;
  assignmentScope?: AgentScope;
  assignmentTeamIds?: string[];
  onSelectedCountChange?: (count: number) => void;
  /**
   * Reports the effective set of currently-selected tool ids (pending edits
   * included, server assignments for untouched catalogs). The exclusions editor
   * uses it so a built-in the user just checked here — but hasn't saved — is
   * treated as assigned and not seeded as disabled. Pass a referentially-stable
   * callback (e.g. a `useState` setter).
   */
  onSelectedToolIdsChange?: (toolIds: ReadonlySet<string>) => void;
  /**
   * When true (the agent-environments feature is on), scope the MCP list to
   * `agentEnvironmentId` and report cross-environment selections via
   * `onConflictsChange`. When false, all catalogs are shown and no conflicts
   * are computed.
   */
  environmentScopingEnabled?: boolean;
  /** The agent's environment id; `null` = the Default runtime bucket. */
  agentEnvironmentId?: string | null;
  /** Display name of the agent's environment for the filter hint (null = Default runtime). */
  agentEnvironmentName?: string | null;
  /**
   * Reports MCP catalogs that are selected but don't belong to the agent's
   * environment. Pass a referentially-stable callback (e.g. a `useState`
   * setter) to avoid effect loops.
   */
  onConflictsChange?: (conflicts: McpEnvConflict[]) => void;
  /**
   * Reports whether the editor holds tool or credential edits that a save
   * would write — the same diff `saveChanges` runs — so the host form can
   * count them as unsaved changes. Pass a referentially-stable callback (e.g.
   * a `useState` setter).
   */
  onPendingChangesChange?: (hasPendingChanges: boolean) => void;
  /** "pills" (default): compact pills + dropdown combobox. "cards": inline grid of MCP server cards. */
  layout?: "pills" | "cards";
  /** When true, the "Add MCP server" combobox starts open. */
  openComboboxOnMount?: boolean;
  /**
   * Include assignable App backing catalogs in the picker. Chat agents, MCP
   * gateways, and legacy profiles set this — a chat agent renders an app inline
   * from its `__open` tool, a gateway/profile exposes that tool to a connected
   * MCP client. The backend still gates their inclusion on `app:read`.
   */
  includeAppCatalogs?: boolean;
}

export const AgentToolsEditor = forwardRef<
  AgentToolsEditorRef,
  AgentToolsEditorProps
>(function AgentToolsEditor(
  {
    agentId,
    assignmentScope,
    assignmentTeamIds,
    onSelectedCountChange,
    onSelectedToolIdsChange,
    environmentScopingEnabled,
    agentEnvironmentId,
    agentEnvironmentName,
    onConflictsChange,
    onPendingChangesChange,
    layout = "pills",
    openComboboxOnMount,
    includeAppCatalogs,
  },
  ref,
) {
  return (
    <AgentToolsEditorContent
      agentId={agentId}
      assignmentScope={assignmentScope}
      assignmentTeamIds={assignmentTeamIds}
      onSelectedCountChange={onSelectedCountChange}
      onSelectedToolIdsChange={onSelectedToolIdsChange}
      environmentScopingEnabled={environmentScopingEnabled}
      agentEnvironmentId={agentEnvironmentId}
      agentEnvironmentName={agentEnvironmentName}
      onConflictsChange={onConflictsChange}
      onPendingChangesChange={onPendingChangesChange}
      layout={layout}
      openComboboxOnMount={openComboboxOnMount}
      includeAppCatalogs={includeAppCatalogs}
      ref={ref}
    />
  );
});

const AgentToolsEditorContent = forwardRef<
  AgentToolsEditorRef,
  AgentToolsEditorProps
>(function AgentToolsEditorContent(
  {
    agentId,
    assignmentScope,
    assignmentTeamIds,
    onSelectedCountChange,
    onSelectedToolIdsChange,
    environmentScopingEnabled = false,
    agentEnvironmentId = null,
    agentEnvironmentName,
    onConflictsChange,
    onPendingChangesChange,
    layout = "pills",
    openComboboxOnMount,
    includeAppCatalogs = false,
  },
  ref,
) {
  const { catalogName } = useArchestraMcpIdentity();
  const queryClient = useQueryClient();
  const invalidateAllQueries = useInvalidateToolAssignmentQueries();
  const bulkUpdateTools = useBulkUpdateAgentTools();

  // Fetch catalog items (MCP servers in registry; the gateway dialog also opts
  // in to assignable App backings via includeAppCatalogs).
  const {
    data: catalogItems = [],
    isPending,
    isLoadingError: catalogFailed,
    refetch: refetchCatalog,
  } = useInternalMcpCatalog({
    includeApps: includeAppCatalogs,
  });

  // Fetch all credentials grouped by catalog (for default credential on toggle)
  const allCredentials = useMcpServersGroupedByCatalog({
    assignmentScope,
    assignmentTeamIds,
  });
  // Tool counts come from the catalog list itself (`toolCount`, one grouped
  // COUNT server-side over exactly the rows a picker lists). This used to be a
  // per-catalog `useQueries` fan-out — one request per catalog item, each
  // returning full tool rows with their assigned-agent lists, purely to read
  // `.length` — which on a real registry queued behind itself in the browser's
  // connection pool and held this component on "Loading tools...".
  const toolCountByCatalog = useMemo(() => {
    const map = new Map<string, number>();
    for (const catalog of catalogItems) {
      map.set(catalog.id, catalog.toolCount ?? 0);
    }
    return map;
  }, [catalogItems]);

  // Fetch assigned tools for this resource (only when editing an existing one).
  // Use the resource-scoped endpoint so MCP gateway members do not need the
  // broader tool-policy table permission just to edit their gateway tools.
  const { data: assignedToolsData = [] } = useProfileToolsWithIds(agentId);

  // Group assigned tools by catalogId
  const assignedToolsByCatalog = useMemo(() => {
    const map = new Map<string, AssignedTool[]>();
    for (const tool of assignedToolsData) {
      const catalogId = tool.catalogId;
      if (!catalogId) continue;
      if (!map.has(catalogId)) map.set(catalogId, []);
      map.get(catalogId)?.push({
        tool,
        mcpServerId: tool.mcpServerId,
        credentialResolutionMode: tool.credentialResolutionMode,
      });
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

  // A catalog belongs to the agent's environment when it's a builtin (always
  // available everywhere, e.g. the Archestra platform tools) or its environment
  // matches — `null` (Default runtime) is its own bucket.
  const isEnvCompatible = useCallback(
    (catalog: InternalMcpCatalogItem) =>
      isCatalogInEnvironment(catalog, agentEnvironmentId ?? null),
    [agentEnvironmentId],
  );

  // All catalogs are offered; when environment scoping is on, catalogs outside
  // the agent's environment are shown disabled (grayed) in the combobox rather
  // than hidden, so it's clear why they can't be selected. Already-selected
  // incompatible ones still render as pills so they can be removed.
  const visibleCatalogItems = sortedCatalogItems;

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

  // Latest cross-environment conflicts, mirrored to a ref so the imperative
  // `removeIncompatibleTools()` can read them without a render dependency.
  const conflictsRef = useRef<McpEnvConflict[]>([]);

  const { data: organization } = useOrganization();
  const skillToolsEnabled = organization?.skillToolsEnabled === true;
  const sandboxEnabled = useFeature("sandbox") === true;

  // The built-in catalog's tools, fetched only while creating an agent — the
  // one place this component still needs a tool list rather than a count, to
  // pre-select the creation defaults. Every other catalog's list stays lazy,
  // loaded by a pill when its popover opens.
  const { data: builtInCatalogTools } = useCatalogTools(
    agentId ? null : ARCHESTRA_MCP_CATALOG_ID,
  );

  // The creation-default built-in set, composed by the shared
  // getCreationDefaultArchestraToolShortNames from the same org/deployment
  // flags AgentModel.create reads server-side. Null while editing an existing
  // agent. Used twice: to pre-select the new-agent form, and as the
  // saveChanges baseline for the built-in catalog right after create.
  const creationDefaultTools = useMemo(() => {
    if (agentId) return null; // Only for new agent creation
    if (!builtInCatalogTools?.length) return null;
    const toolIds = filterDefaultArchestraToolIds(builtInCatalogTools, {
      skillsEnabled: skillToolsEnabled,
      sandboxEnabled,
    });
    return toolIds.size > 0 ? toolIds : null;
  }, [agentId, builtInCatalogTools, skillToolsEnabled, sandboxEnabled]);

  // Pre-select the creation-default Archestra tools when creating a new agent
  // (no agentId), so the form shows exactly what AgentModel.create will assign
  // server-side.
  useEffect(() => {
    if (defaultToolsInitializedRef.current) return; // Only initialize once
    if (!creationDefaultTools) return;

    const archestraCatalog = catalogItems.find(
      (catalog) => catalog.id === ARCHESTRA_MCP_CATALOG_ID,
    );
    if (!archestraCatalog) return;

    defaultToolsInitializedRef.current = true;
    pendingChangesRef.current.set(ARCHESTRA_MCP_CATALOG_ID, {
      selectedToolIds: creationDefaultTools,
      credentialSourceId: null,
      catalogItem: archestraCatalog,
      selectAll: false,
    });
    onSelectedCountChange?.(creationDefaultTools.size);
    setPendingVersion((v) => v + 1);
  }, [creationDefaultTools, catalogItems, onSelectedCountChange]);

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

  // Effective current selection across every catalog: the pending edit when the
  // user has touched a catalog, otherwise its saved assignments. Reported to the
  // dialog so the exclusions editor's seed reflects unsaved Custom-tab edits.
  // biome-ignore lint/correctness/useExhaustiveDependencies: pendingVersion triggers re-computation when pendingChangesRef updates
  const effectiveSelectedToolIds = useMemo(() => {
    const ids = new Set<string>();
    for (const catalog of catalogItems) {
      const pending = pendingChangesRef.current.get(catalog.id);
      if (pending) {
        for (const id of pending.selectedToolIds) ids.add(id);
      } else {
        for (const at of assignedToolsByCatalog.get(catalog.id) ?? [])
          ids.add(at.tool.id);
      }
    }
    return ids;
  }, [catalogItems, assignedToolsByCatalog, pendingVersion]);

  // Report only when the CONTENT changes. The memo's inputs get fresh
  // identities on every render while the queries are loading (`data = []`
  // defaults), so keying the parent's setState off the Set's identity would
  // loop render → new Set → setState → render forever and crash the dialog.
  const lastReportedSelectionKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (!onSelectedToolIdsChange) return;
    const key = [...effectiveSelectedToolIds].sort().join(",");
    if (lastReportedSelectionKeyRef.current === key) return;
    lastReportedSelectionKeyRef.current = key;
    onSelectedToolIdsChange(effectiveSelectedToolIds);
  }, [effectiveSelectedToolIds, onSelectedToolIdsChange]);

  // Whether a save would write anything — the very diff `saveChanges` runs,
  // so the host's unsaved-changes state agrees with what Save does. Every
  // mounted pill registers its (unchanged) state as a pending entry, so the
  // map's size alone says nothing; only the diff does.
  // biome-ignore lint/correctness/useExhaustiveDependencies: pendingVersion triggers re-computation when pendingChangesRef updates
  const hasPendingChanges = useMemo(
    () =>
      buildBulkToolUpdate({
        targetAgentId: agentId ?? "",
        pendingChanges: pendingChangesRef.current,
        assignedToolsByCatalog,
        isNewAgent: !agentId,
        creationDefaultToolIds: creationDefaultTools ?? undefined,
      }).hasChanges,
    [agentId, assignedToolsByCatalog, creationDefaultTools, pendingVersion],
  );
  useEffect(() => {
    onPendingChangesChange?.(hasPendingChanges);
  }, [hasPendingChanges, onPendingChangesChange]);

  // Expose saveChanges method to parent
  useImperativeHandle(ref, () => ({
    saveChanges: async (params) => {
      const targetAgentId = params?.agentId ?? agentId;
      const resourceLabel = params?.resourceLabel ?? "resource";
      if (!targetAgentId) return;

      // Every catalog's edits are accumulated and sent as ONE request. Looping
      // per tool (the previous shape) forked an agent config version per
      // request, so adding a 30-tool server burned 30 of the 100 retained
      // versions and an add-then-remove cycle evicted the edits a human made.
      const { assignments, removals, hasChanges } = buildBulkToolUpdate({
        targetAgentId,
        pendingChanges: pendingChangesRef.current,
        assignedToolsByCatalog,
        isNewAgent: !agentId,
        creationDefaultToolIds: creationDefaultTools ?? undefined,
      });

      // `failed` is the only part of the response that is an error — see
      // summarizeBulkFailure, which is deliberately the only thing read off it.
      let failure: string | undefined;
      if (assignments.length > 0 || removals.length > 0) {
        const result = await bulkUpdateTools.mutateAsync({
          assignments,
          removals,
          skipInvalidation: true,
        });
        failure = summarizeBulkFailure(result?.failed);
      }

      // Invalidate once at the end — before any throw, because a partial
      // failure still applied the removals and the assignments that validated,
      // and the cached tool lists would otherwise stay stale.
      if (hasChanges) {
        invalidateAllQueries(targetAgentId);
      }

      if (failure) {
        throw new Error(
          formatToolAssignmentErrorMessage(resourceLabel, new Error(failure)),
        );
      }

      // Clear all pending changes after save
      pendingChangesRef.current.clear();
    },
    removeIncompatibleTools: () => {
      for (const { catalogId } of conflictsRef.current) {
        const catalog = catalogItems.find((c) => c.id === catalogId);
        if (!catalog) continue;
        const pending = pendingChangesRef.current.get(catalogId);
        registerPendingChanges(catalogId, {
          selectedToolIds: new Set(),
          credentialSourceId: pending?.credentialSourceId ?? null,
          catalogItem: catalog,
          selectAll: false,
          isActive: false,
        });
      }
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

  // Catalogs that are selected but don't belong to the agent's environment.
  // Builtins are exempt. Empty when scoping is off.
  const mcpEnvConflicts = useMemo<McpEnvConflict[]>(
    () =>
      environmentScopingEnabled
        ? computeMcpEnvConflicts(
            catalogItems,
            selectedCatalogIds,
            agentEnvironmentId ?? null,
          )
        : [],
    [
      environmentScopingEnabled,
      selectedCatalogIds,
      catalogItems,
      agentEnvironmentId,
    ],
  );

  // Mirror conflicts to a ref for the imperative remove, and report upward.
  // `mcpEnvConflicts` is recomputed (new array) on every render because its
  // dependency chain bottoms out in non-stable query results, so we diff by
  // content and only call up on a real change — otherwise the parent's setState
  // would re-render us in an infinite loop.
  useEffect(() => {
    const prev = conflictsRef.current;
    const changed =
      prev.length !== mcpEnvConflicts.length ||
      mcpEnvConflicts.some((c, i) => prev[i]?.catalogId !== c.catalogId);
    conflictsRef.current = mcpEnvConflicts;
    if (changed) onConflictsChange?.(mcpEnvConflicts);
  }, [mcpEnvConflicts, onConflictsChange]);

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
        // Toggle ON: pre-select the catalog's tools using cached data — a pill
        // that has already been opened leaves its list in the query cache.
        const tools =
          queryClient.getQueryData<CatalogTool[]>([
            "mcp-catalog",
            catalogId,
            "tools",
          ]) ?? [];
        const allToolIds = new Set(tools.map((t) => t.id));

        // The built-in Archestra catalog re-adds to its creation-default subset
        // (what a new agent gets), not all its tools; every other server has no
        // default subset, so it still selects all. When the tool cache is cold
        // `tools` is empty and the parent can't pre-compute — the pill fills the
        // selection reactively from its own authoritative list via the
        // selectAll / selectDefaults flags. We never set selectAll for
        // Archestra, since that backstop would expand to all tools.
        const isArchestra = catalogId === ARCHESTRA_MCP_CATALOG_ID;

        registerPendingChanges(catalogId, {
          selectedToolIds: isArchestra
            ? filterDefaultArchestraToolIds(tools, {
                skillsEnabled: skillToolsEnabled,
                sandboxEnabled,
              })
            : allToolIds,
          // Newly assigned tools default to resolve-at-call-time, which follows
          // the server's default credential setting; pinning a static
          // credential is an explicit per-assignment choice.
          credentialSourceId:
            pending?.credentialSourceId ?? DYNAMIC_CREDENTIAL_VALUE,
          catalogItem: catalog,
          selectAll: !isArchestra,
          selectDefaults: isArchestra,
          isActive: true,
        });
      }
    },
    [
      catalogItems,
      assignedToolsByCatalog,
      queryClient,
      registerPendingChanges,
      skillToolsEnabled,
      sandboxEnabled,
    ],
  );

  // Build combobox items
  // biome-ignore lint/correctness/useExhaustiveDependencies: pendingVersion triggers re-computation when pendingChangesRef updates
  const comboboxItems: AssignmentComboboxItem[] = useMemo(() => {
    return visibleCatalogItems.map((catalog) => {
      const pending = pendingChangesRef.current.get(catalog.id);
      const assignedCount = pending
        ? pending.selectedToolIds.size
        : (assignedToolsByCatalog.get(catalog.id)?.length ?? 0);
      const totalCount = toolCountByCatalog.get(catalog.id) ?? 0;
      const hasResolvableInstall =
        isCredentialLessCatalogType(catalog.serverType) ||
        !!allCredentials?.[catalog.id]?.length;
      const gate = getCatalogAssignmentGate({
        hasDiscoveredTools: totalCount > 0,
        hasResolvableInstall,
        isEnvIncompatible:
          environmentScopingEnabled && !isEnvCompatible(catalog),
        environmentName: agentEnvironmentName,
        isDisabledApp:
          catalog.serverType === "app" && catalog.appEnabled === false,
      });
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
        badge: gate.disabled
          ? undefined
          : gate.unavailable
            ? "Not connected"
            : assignedCount > 0
              ? `${assignedCount}/${totalCount}`
              : `${totalCount} tools`,
        disabled: gate.disabled,
        disabledReason: gate.disabledReason,
      };
    });
  }, [
    visibleCatalogItems,
    assignedToolsByCatalog,
    toolCountByCatalog,
    allCredentials,
    pendingVersion,
    environmentScopingEnabled,
    isEnvCompatible,
    agentEnvironmentName,
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

  // The catalog list is the one request this picker cannot render without, and
  // a failed one leaves `catalogItems` empty — which the gate below reports as
  // "No MCP servers available in the catalog.", indistinguishable from an
  // organization that genuinely has none. That reads as "your registry is
  // empty" rather than "we couldn't reach it", and the query is silent
  // (`toastOnError: false`), so nothing else on screen says otherwise.
  //
  // Now that tool counts come from this list, it carries the whole picker: the
  // per-catalog fan-out that used to fill in around it is gone, so there is no
  // second request left to hint that anything was attempted.
  if (catalogFailed) {
    return (
      <QueryLoadError
        className="py-6"
        title="Couldn't load the MCP server catalog"
        description="The list of servers whose tools can be assigned failed to load."
        onRetry={() => {
          void refetchCatalog();
        }}
        retryTestId="retry-tools-catalog"
      />
    );
  }

  if (catalogItems.length === 0) {
    // Installing one is an organization-wide job, not this record's, so the
    // panel says whose it is and points there rather than stopping at the fact.
    return (
      <EmptyState
        className="py-6"
        icon={Server}
        title="No MCP servers are installed"
        description="Servers are installed once for the whole organization. Until one is, there is nothing to assign here."
        action={
          <Button type="button" variant="outline" size="sm" asChild>
            <Link href="/mcp/registry">Browse the MCP Registry</Link>
          </Button>
        }
      />
    );
  }

  if (layout === "cards") {
    return (
      <div className="grid grid-cols-3 gap-2">
        {visibleCatalogItems.map((catalog) => {
          const isSelected = selectedCatalogIds.includes(catalog.id);
          const pending = pendingChangesRef.current.get(catalog.id);
          const assignedCount = pending
            ? pending.selectedToolIds.size
            : (assignedToolsByCatalog.get(catalog.id)?.length ?? 0);
          const totalCount = toolCountByCatalog.get(catalog.id) ?? 0;
          // The cards layout is not environment-scoped (McpServerCard has no
          // reason slot), so tool discovery is the only assignability gate here.
          const gate = getCatalogAssignmentGate({
            hasDiscoveredTools: totalCount > 0,
            hasResolvableInstall:
              isCredentialLessCatalogType(catalog.serverType) ||
              !!allCredentials?.[catalog.id]?.length,
            isEnvIncompatible: false,
            isDisabledApp:
              catalog.serverType === "app" && catalog.appEnabled === false,
          });

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
              isDisabled={gate.disabled}
              unavailable={gate.unavailable}
              assignedCount={assignedCount}
              totalCount={totalCount}
              onToggle={() => handleCatalogToggle(catalog.id)}
            />
          );
        })}
      </div>
    );
  }

  // Nothing assigned yet, but there is something to assign: say what that costs
  // the record rather than leaving a lone Add button to imply it.
  const isEmpty = selectedCatalogs.length === 0;

  return (
    <div className="space-y-2">
      <div
        className={cn(
          "flex flex-wrap gap-2",
          isEmpty &&
            "flex-col items-center rounded-md border border-dashed px-4 py-6 text-center",
        )}
      >
        {isEmpty && (
          <div className="space-y-0.5">
            <p className="text-sm font-medium">No tools assigned yet</p>
            {/* No record noun: this editor serves agents, gateways and
                proxies, and naming one of them here is how the connection
                strings drifted apart before. */}
            <p className="text-xs text-muted-foreground">
              Add an MCP server to choose tools from.
            </p>
          </div>
        )}
        {selectedCatalogs.map((catalog) => (
          <McpServerPill
            key={catalog.id}
            catalogItem={catalog}
            displayName={
              catalog.id === ARCHESTRA_MCP_CATALOG_ID
                ? catalogName
                : catalog.name
            }
            assignedTools={assignedToolsByCatalog.get(catalog.id) ?? []}
            assignmentScope={assignmentScope}
            assignmentTeamIds={assignmentTeamIds}
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
          // The scope belongs to this list, not to the pills a pick produces.
          note={
            environmentScopingEnabled
              ? `Filtered to the ${agentEnvironmentName ?? "Default"} environment.`
              : undefined
          }
          testId={E2eTestId.AgentToolsAddButton}
          defaultOpen={openComboboxOnMount}
          createAction={{
            label: "Install New MCP Server",
            href: "/mcp/registry",
          }}
        />
      </div>
    </div>
  );
});

function McpServerCard({
  catalog,
  displayName,
  isSelected,
  isDisabled,
  unavailable,
  assignedCount,
  totalCount,
  onToggle,
}: {
  catalog: InternalMcpCatalogItem;
  displayName: string;
  isSelected: boolean;
  isDisabled: boolean;
  unavailable: boolean;
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
          : unavailable
            ? "Not connected"
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
  assignedTools: AssignedTool[];
  assignmentScope?: AgentScope;
  assignmentTeamIds?: string[];
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
  assignmentScope,
  assignmentTeamIds,
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

  // Org/deployment flags that compose the Archestra creation-default set. Read
  // here (not prop-drilled) so the selectDefaults backstop below can compute
  // defaults from this pill's own authoritative tool list. Cached by TanStack
  // Query, so this shares the parent's fetch.
  const { data: organization } = useOrganization();
  const skillToolsEnabled = organization?.skillToolsEnabled === true;
  const sandboxEnabled = useFeature("sandbox") === true;

  // Creation-default subset for the built-in catalog: powers the checklist's
  // "Reset to defaults" action, so restoring a drifted selection no longer
  // requires removing and re-adding the server. Undefined for every other
  // server — they have no default subset, so the action is hidden.
  const defaultToolIds = useMemo(
    () =>
      catalogItem.id === ARCHESTRA_MCP_CATALOG_ID
        ? filterDefaultArchestraToolIds(allTools, {
            skillsEnabled: skillToolsEnabled,
            sandboxEnabled,
          })
        : undefined,
    [catalogItem.id, allTools, skillToolsEnabled, sandboxEnabled],
  );

  // Fetch available credentials for this catalog
  const credentials = useMcpServersGroupedByCatalog({
    catalogId: catalogItem.id,
    assignmentScope,
    assignmentTeamIds,
  });
  const mcpServers = credentials?.[catalogItem.id] ?? [];
  const prefersEnterpriseManaged = catalogItem.enterpriseManagedConfig != null;

  // Static assignments show their pinned connection; everything else —
  // dynamic, enterprise-managed, or a brand-new assignment — defaults to
  // resolve-at-call-time. Shared with the bulk-save diff, so an untouched
  // pick never reads as a change.
  const currentCredentialSource = credentialSourceOfAssignments(assignedTools);

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

  useEffect(() => {
    if (
      shouldResetCredentialPin({
        credentialsLoaded: !!credentials,
        selectionIsDynamic: selectedCredential === DYNAMIC_CREDENTIAL_VALUE,
        pinnedServerId:
          selectedCredential && selectedCredential !== DYNAMIC_CREDENTIAL_VALUE
            ? selectedCredential
            : null,
        resolvableServerIds: mcpServers.map((server) => server.id),
      })
    ) {
      setSelectedCredential(DYNAMIC_CREDENTIAL_VALUE);
    }
  }, [credentials, mcpServers, selectedCredential]);

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

  // Auto-select the creation-default subset when selectDefaults is set and tools
  // finish loading. Mirrors pendingSelectAllRef, but pre-selects only the
  // default Archestra tools — the backstop for re-adding the built-in catalog
  // when the parent's tool cache was cold at click time. Fires once at mount.
  const pendingSelectDefaultsRef = useRef(
    initialPendingChanges?.selectDefaults ?? false,
  );
  useEffect(() => {
    if (!pendingSelectDefaultsRef.current || allTools.length === 0) return;

    if (selectedToolIds.size === 0) {
      const defaults = filterDefaultArchestraToolIds(allTools, {
        skillsEnabled: skillToolsEnabled,
        sandboxEnabled,
      });
      // Fall back to all tools only if nothing matched, so a naming mismatch
      // never strands the user on zero tools.
      setSelectedToolIds(
        defaults.size > 0 ? defaults : new Set(allTools.map((t) => t.id)),
      );
    }
    // Clear the flag regardless so we don't fight user deselections.
    pendingSelectDefaultsRef.current = false;
    // Depend on .size (not the full set) — see pendingSelectAllRef above.
  }, [selectedToolIds.size, allTools, skillToolsEnabled, sandboxEnabled]);

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

  const assignedCount = assignedTools.length;
  const totalCount = allTools.length;
  const displayedCount = hasPendingChanges
    ? selectedToolIds.size
    : assignedCount;
  const isEmpty = displayedCount === 0;

  // Show the connection selector for non-builtin, non-App, non-Playwright
  // servers. It always offers resolve-at-call-time, so a server with no
  // connection that resolves for the caller still shows it — that is how the
  // dynamic per-caller resolution (and any pinned-but-unavailable connection)
  // stays visible for an assignment made without a local install.
  const isPlaywright = isPlaywrightCatalogItem(catalogItem.id);
  const showCredentialSelector =
    !isCredentialLessCatalogType(catalogItem.serverType) && !isPlaywright;
  return (
    <McpServerPillShell
      icon={
        <McpCatalogIcon
          icon={catalogItem.icon}
          catalogId={catalogItem.id}
          size={14}
        />
      }
      displayName={displayName}
      count={displayedCount}
      isEmpty={isEmpty}
      highlighted={hasPendingChanges}
      description={catalogItem.description}
      docsUrl={catalogItem.docsUrl}
      open={open}
      onOpenChange={(v) => {
        setOpen(v);
        if (v) setChangedInSession(false);
      }}
      onRemove={() => onRemove(catalogItem.id)}
      removeAriaLabel={`Remove ${catalogItem.name}`}
      triggerTestId={getAgentToolCatalogPillTestId(catalogItem.name)}
    >
      {showCredentialSelector && (
        <div className="p-4 border-b space-y-2 shrink-0">
          <Label className="text-sm font-medium">Connect on behalf of</Label>
          <TokenSelect
            catalogId={catalogItem.id}
            assignmentScope={assignmentScope}
            assignmentTeamIds={assignmentTeamIds}
            value={selectedCredential}
            onValueChange={setSelectedCredential}
            shouldSetDefaultValue={false}
            prefersEnterpriseManaged={prefersEnterpriseManaged}
          />
        </div>
      )}

      {isLoadingTools ? (
        <div className="p-4 flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          <span>Loading tools...</span>
        </div>
      ) : totalCount === 0 ? (
        <div className="p-4 text-sm text-muted-foreground">
          <span>No tools available for this server.</span>
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
            defaultToolIds={defaultToolIds}
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
    </McpServerPillShell>
  );
}

export interface ToolChecklistProps {
  tools: CatalogTool[];
  selectedToolIds: Set<string>;
  onSelectionChange: (selectedIds: Set<string>) => void;
  /**
   * What a checked row means. "assign" (default) keeps the neutral
   * selection language; "disable" is the exclusions editor, where checked
   * tools are disabled for the agent — counts, bulk buttons, and row
   * styling all say so.
   */
  variant?: "assign" | "disable";
  /**
   * The creation-default tool IDs for servers that have such a subset (the
   * built-in Archestra catalog). When provided and non-empty, the header gains
   * a "Reset to defaults" action that replaces the whole selection with
   * exactly this set — unlike Select All/Deselect All it ignores any active
   * search filter, since a partial reset is not a reset.
   */
  defaultToolIds?: Set<string>;
}

function formatToolName(toolName: string) {
  return parseFullToolName(toolName).toolName || toolName;
}

function formatToolAssignmentErrorMessage(
  resourceLabel: string,
  error: unknown,
) {
  const message =
    error instanceof Error && error.message ? error.message : "Request failed";
  const normalizedResourceLabel = resourceLabel.trim() || "resource";
  const lowerResourceLabel = normalizedResourceLabel.toLowerCase();

  if (message === "This team connection is not shared with the selected team") {
    return `This ${lowerResourceLabel} cannot use that connection because it is not shared with one of the selected teams`;
  }

  if (
    message ===
    "The credential owner must be a member of a team that this resource is assigned to"
  ) {
    return `This ${lowerResourceLabel} cannot use that connection because the credential owner does not have access to the selected team`;
  }

  return `Failed to update tools for this ${lowerResourceLabel}: ${message}`;
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

function ToolRow({
  tool,
  isSelected,
  disableVariant,
  onToggle,
}: {
  tool: CatalogTool;
  isSelected: boolean;
  disableVariant: boolean;
  onToggle: (toolId: string) => void;
}) {
  const toolName = formatToolName(tool.name);
  return (
    <label
      htmlFor={`tool-${tool.id}`}
      className={cn(
        "flex items-start gap-3 p-2 rounded-md transition-colors cursor-pointer",
        !isSelected && "hover:bg-muted/50",
        isSelected && (disableVariant ? "bg-destructive/10" : "bg-primary/10"),
      )}
    >
      <Checkbox
        id={`tool-${tool.id}`}
        checked={isSelected}
        onCheckedChange={() => onToggle(tool.id)}
        className="mt-0.5"
      />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <div className="text-sm font-medium">{toolName}</div>
          {disableVariant && isSelected && (
            <Badge
              variant="outline"
              className="border-destructive/40 text-destructive px-1.5 py-0"
            >
              Disabled
            </Badge>
          )}
        </div>
        {tool.description && (
          <ExpandableDescription description={tool.description} />
        )}
      </div>
    </label>
  );
}

const OTHER_GROUP_ID = "__other__";
const KNOWN_GROUP_IDS = new Set<string>(
  ARCHESTRA_TOOL_GROUPS.map((group) => group.id),
);

/**
 * Section id a tool renders under. A tool with no group or an unrecognized one
 * (an external MCP tool, or a newer server group id this build doesn't know
 * yet) maps to "Other" — never dropped, since only rendered sections are
 * reachable. Single source for both bucketing and header counts so a body and
 * its count can't diverge.
 */
function toolGroupKey(tool: CatalogTool): string {
  return tool.group && KNOWN_GROUP_IDS.has(tool.group)
    ? tool.group
    : OTHER_GROUP_ID;
}

/**
 * Buckets tools into domain sections in canonical `ARCHESTRA_TOOL_GROUPS`
 * order. Empty groups are omitted; the "Other" section is appended last when
 * non-empty.
 */
function bucketToolsByGroup(
  tools: CatalogTool[],
): { id: string; label: string; tools: CatalogTool[] }[] {
  const byGroup = new Map<string, CatalogTool[]>();
  for (const tool of tools) {
    const key = toolGroupKey(tool);
    const bucket = byGroup.get(key);
    if (bucket) {
      bucket.push(tool);
    } else {
      byGroup.set(key, [tool]);
    }
  }

  const sections: { id: string; label: string; tools: CatalogTool[] }[] = [];
  for (const group of ARCHESTRA_TOOL_GROUPS) {
    const groupTools = byGroup.get(group.id);
    if (groupTools && groupTools.length > 0) {
      sections.push({ id: group.id, label: group.label, tools: groupTools });
    }
  }
  const otherTools = byGroup.get(OTHER_GROUP_ID);
  if (otherTools && otherTools.length > 0) {
    sections.push({ id: OTHER_GROUP_ID, label: "Other", tools: otherTools });
  }
  return sections;
}

export function ToolChecklist({
  tools,
  selectedToolIds,
  onSelectionChange,
  variant = "assign",
  defaultToolIds,
}: ToolChecklistProps) {
  const [searchQuery, setSearchQuery] = useState("");
  const disableVariant = variant === "disable";

  // Hidden when the set is empty so the action can never reset to zero tools.
  const showResetToDefaults = defaultToolIds != null && defaultToolIds.size > 0;
  const selectionAtDefaults =
    defaultToolIds != null && setsEqual(selectedToolIds, defaultToolIds);

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

  const setToolsSelected = (groupTools: CatalogTool[], selected: boolean) => {
    const newSet = new Set(selectedToolIds);
    for (const tool of groupTools) {
      if (selected) {
        newSet.add(tool.id);
      } else {
        newSet.delete(tool.id);
      }
    }
    onSelectionChange(newSet);
  };

  // Built-in Archestra tools carry a domain group; render collapsible sections
  // when at least one does. External MCP tools have none, so the flat list
  // stays the fallback. Counts use the full group (stable while searching);
  // section select-all/clear act on the group's currently visible tools.
  const grouped = tools.some((tool) => tool.group);
  const sections = useMemo(
    () => (grouped ? bucketToolsByGroup(filteredTools) : []),
    [grouped, filteredTools],
  );
  const fullGroupTotals = useMemo(() => {
    const totals = new Map<string, { total: number; selected: number }>();
    if (!grouped) return totals;
    for (const tool of tools) {
      const key = toolGroupKey(tool);
      const entry = totals.get(key) ?? { total: 0, selected: 0 };
      entry.total += 1;
      if (selectedToolIds.has(tool.id)) entry.selected += 1;
      totals.set(key, entry);
    }
    return totals;
  }, [grouped, tools, selectedToolIds]);

  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(
    // Collapsed by default: the per-section count is the scannable summary.
    () =>
      new Set([
        ...ARCHESTRA_TOOL_GROUPS.map((group) => group.id),
        OTHER_GROUP_ID,
      ]),
  );
  const isSearching = searchQuery.trim().length > 0;
  const toggleGroup = (groupId: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(groupId)) {
        next.delete(groupId);
      } else {
        next.add(groupId);
      }
      return next;
    });
  };

  return (
    <div className="flex flex-col min-h-0 flex-1">
      <div className="px-4 py-2 border-b flex items-center justify-between bg-muted/30 shrink-0">
        <span className="text-xs text-muted-foreground">
          {selectedCount} of {tools.length}{" "}
          {disableVariant ? "disabled" : "selected"}
        </span>
        <div className="flex gap-1">
          <Button
            variant="ghost"
            size="sm"
            className="text-xs h-6 px-2"
            onClick={handleSelectAll}
            disabled={allSelected}
          >
            {disableVariant ? "Disable all" : "Select All"}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="text-xs h-6 px-2"
            onClick={handleDeselectAll}
            disabled={noneSelected}
          >
            {disableVariant ? "Enable all" : "Deselect All"}
          </Button>
          {showResetToDefaults && (
            <Button
              variant="ghost"
              size="sm"
              className="text-xs h-6 px-2"
              onClick={() => onSelectionChange(new Set(defaultToolIds))}
              disabled={selectionAtDefaults}
              title="Replace the selection with the default set assigned at creation"
            >
              Reset to defaults
            </Button>
          )}
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
              aria-label="Search tools"
            />
          </div>
        </div>
      )}
      <div className="flex-1 min-h-0 overflow-y-auto">
        {grouped ? (
          <div className="p-2 space-y-1">
            {sections.length === 0 ? (
              <div className="text-center py-4 text-sm text-muted-foreground">
                No tools match your search
              </div>
            ) : (
              sections.map((section) => {
                const totals = fullGroupTotals.get(section.id) ?? {
                  total: section.tools.length,
                  selected: 0,
                };
                // While searching, keep matching sections open so results show.
                const expanded =
                  isSearching || !collapsedGroups.has(section.id);
                const allGroupSelected = section.tools.every((tool) =>
                  selectedToolIds.has(tool.id),
                );
                const noneGroupSelected = section.tools.every(
                  (tool) => !selectedToolIds.has(tool.id),
                );
                return (
                  <div
                    key={section.id}
                    className="rounded-md border overflow-hidden"
                  >
                    <div className="flex items-center justify-between gap-2 px-2 py-1.5 bg-muted/40">
                      <button
                        type="button"
                        onClick={() => toggleGroup(section.id)}
                        disabled={isSearching}
                        aria-expanded={expanded}
                        className="flex items-center gap-1.5 min-w-0 disabled:cursor-default"
                      >
                        {expanded ? (
                          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                        ) : (
                          <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                        )}
                        <span className="text-xs font-semibold truncate">
                          {section.label}
                        </span>
                        <span className="text-xs text-muted-foreground shrink-0">
                          {totals.selected}/{totals.total}
                        </span>
                      </button>
                      <div className="flex gap-1 shrink-0">
                        <Button
                          variant="ghost"
                          size="sm"
                          className="text-xs h-5 px-1.5"
                          onClick={() => setToolsSelected(section.tools, true)}
                          disabled={allGroupSelected}
                          aria-label={`${disableVariant ? "Disable all" : "Select all"} ${section.label} tools`}
                        >
                          {disableVariant ? "Disable all" : "Select all"}
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="text-xs h-5 px-1.5"
                          onClick={() => setToolsSelected(section.tools, false)}
                          disabled={noneGroupSelected}
                          aria-label={`${disableVariant ? "Enable all" : "Clear"} ${section.label} tools`}
                        >
                          {disableVariant ? "Enable all" : "Clear"}
                        </Button>
                      </div>
                    </div>
                    {expanded && (
                      <div className="p-1 space-y-0.5">
                        {section.tools.map((tool) => (
                          <ToolRow
                            key={tool.id}
                            tool={tool}
                            isSelected={selectedToolIds.has(tool.id)}
                            disableVariant={disableVariant}
                            onToggle={handleToggle}
                          />
                        ))}
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </div>
        ) : (
          <div className="p-2 space-y-0.5">
            {filteredTools.length === 0 ? (
              <div className="text-center py-4 text-sm text-muted-foreground">
                No tools match your search
              </div>
            ) : (
              filteredTools.map((tool) => (
                <ToolRow
                  key={tool.id}
                  tool={tool}
                  isSelected={selectedToolIds.has(tool.id)}
                  disableVariant={disableVariant}
                  onToggle={handleToggle}
                />
              ))
            )}
          </div>
        )}
      </div>
    </div>
  );
}
