"use client";

import {
  ARCHESTRA_MCP_CATALOG_ID,
  type archestraApiTypes,
  getCreationDefaultArchestraToolShortNames,
} from "@archestra/shared";
import { useQueries } from "@tanstack/react-query";
import { Loader2, Pencil, X } from "lucide-react";
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
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  type AgentToolExclusions,
  useAgentToolExclusions,
  useUpdateAgentToolExclusions,
} from "@/lib/agent-tool-exclusions.query";
import { useProfileToolsWithIds } from "@/lib/chat/chat.query";
import { useConfig, useFeature } from "@/lib/config/config.query";
import { useArchestraMcpIdentity } from "@/lib/mcp/archestra-mcp-server";
import {
  fetchCatalogTools,
  useInternalMcpCatalog,
} from "@/lib/mcp/internal-mcp-catalog.query";
import { useOrganization } from "@/lib/organization.query";
import {
  buildExclusionPayload,
  buildInitialEntries,
  computeDefaultExclusionToolIds,
  EMPTY_EXCLUSIONS,
  exclusionsKey,
  filterExcludableTools,
  mergeExclusionsWithDefaultToolIds,
  type PendingExclusionEntry,
} from "./agent-tool-exclusions-editor.utils";
import { ToolChecklist } from "./agent-tools-editor";
import { McpCatalogIcon } from "./mcp-catalog-icon";

type InternalMcpCatalogItem =
  archestraApiTypes.GetInternalMcpCatalogResponses["200"][number];
type CatalogTool =
  archestraApiTypes.GetInternalMcpCatalogToolsResponses["200"][number];

export interface AgentToolExclusionsEditorRef {
  /**
   * Persist pending exclusion changes via PUT (full replace). No-ops when
   * nothing changed or the editor hasn't finished loading. Pass `agentId`
   * when saving right after creating the agent.
   */
  saveChanges: (params?: { agentId?: string }) => Promise<void>;
}

interface AgentToolExclusionsEditorProps {
  agentId?: string;
  /**
   * Seed the entries with the backend's Auto-mode exclusion pre-fill: the
   * initial state becomes the UNION of the server-saved exclusions and the
   * client-computed default set (every unassigned built-in tool outside the
   * pre-fill-exempt set). Pass true when saving would put the agent into Auto
   * mode from scratch — creating a new agent on the Auto tab, or editing an
   * agent whose SAVED accessAllTools is off while the Auto tab is selected —
   * so the form shows the pre-filled reality instead of an empty list, and a
   * later full-replace save can't wipe the server pre-fill with a stale
   * baseline. While the underlying queries load (or this prop flips), the
   * seeded entries keep recomputing; the user's first manual edit freezes
   * them.
   */
  seedDefaultExclusions?: boolean;
  /**
   * The tools editor's live selection (pending edits included). When present it
   * is unioned into the "assigned" set the seeded default mirror reads, so a
   * built-in the user just checked in the Custom tab — but hasn't saved — is
   * treated as assigned rather than seeded as disabled. Falls back to the saved
   * assignments / creation-default set when absent.
   */
  pendingAssignedToolIds?: ReadonlySet<string>;
  /**
   * Reports `{ initial, current }` normalized exclusion payloads for the
   * dialog's unsaved-changes tracking; called with `null` on unmount. Pass a
   * referentially-stable callback (e.g. a `useState` setter).
   */
  onStateChange?: (
    state: {
      initial: AgentToolExclusions;
      current: AgentToolExclusions;
    } | null,
  ) => void;
}

/**
 * Auto-mode (access all tools) exclusion editor: pick MCP servers to exclude tools
 * from the agent's implicit tool surface. Tools are grouped by server for
 * display; every selection resolves to individual tool ids in the saved
 * payload (exclusion is purely per-tool — there is no whole-server exclusion).
 * Adding a server excludes all of its excludable tools; the pill popover
 * checklist narrows that to a subset. The built-in catalog's meta dispatch
 * tools are never excludable and are hidden from its checklist.
 */
export const AgentToolExclusionsEditor = forwardRef<
  AgentToolExclusionsEditorRef,
  AgentToolExclusionsEditorProps
>(function AgentToolExclusionsEditor(
  {
    agentId,
    seedDefaultExclusions = false,
    pendingAssignedToolIds,
    onStateChange,
  },
  ref,
) {
  const { catalogName } = useArchestraMcpIdentity();
  const { data: catalogItems = [], isPending: catalogsPending } =
    useInternalMcpCatalog();
  const { data: loadedExclusions, isFetched: exclusionsFetched } =
    useAgentToolExclusions(agentId);
  const updateExclusions = useUpdateAgentToolExclusions();

  // Inputs for the seeded default exclusion set (mirrors the backend Auto-mode
  // pre-fill): the agent's saved assignments, or — for a new agent — the
  // creation-default set the backend will auto-assign, composed from the same
  // org/deployment flags the create path reads.
  const { data: assignedTools = [], isFetched: assignedToolsFetched } =
    useProfileToolsWithIds(agentId);
  const { data: organization, isPending: organizationPending } =
    useOrganization();
  const { isPending: configPending } = useConfig();
  const skillToolsEnabled = organization?.skillToolsEnabled === true;
  const sandboxEnabled = useFeature("sandbox") === true;

  // The seeded default set depends on the agent's saved assignments (existing
  // agent) or the org/deployment flags (new agent). Until those inputs load,
  // the mirror is wrong (assignments read as empty → assigned built-ins get
  // excluded; flags read as false → skill/app/sandbox groups get excluded), so
  // gate the seed until they resolve — otherwise a first edit could freeze and
  // then persist that wrong baseline.
  const seedInputsReady =
    !seedDefaultExclusions ||
    (agentId ? assignedToolsFetched : !organizationPending && !configPending);

  // Tool lists for every catalog (shared query keys with the tools editor, so
  // this piggybacks on its cache when both are mounted).
  const toolQueries = useQueries({
    queries: catalogItems.map((catalog) => ({
      queryKey: ["mcp-catalog", catalog.id, "tools"] as const,
      queryFn: () => fetchCatalogTools(catalog.id),
    })),
  });

  // Excludable tools per catalog (meta dispatch tools filtered from the
  // built-in catalog).
  const toolsByCatalog = useMemo(() => {
    const map = new Map<string, CatalogTool[]>();
    for (let i = 0; i < catalogItems.length; i++) {
      const catalog = catalogItems[i];
      const tools = toolQueries[i]?.data as CatalogTool[] | undefined;
      if (catalog && tools) {
        map.set(catalog.id, filterExcludableTools(catalog.id, tools));
      }
    }
    return map;
  }, [catalogItems, toolQueries]);

  const toolIdsByCatalog = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const [catalogId, tools] of toolsByCatalog) {
      map.set(
        catalogId,
        tools.map((t) => t.id),
      );
    }
    return map;
  }, [toolsByCatalog]);

  const allToolsLoaded =
    !catalogsPending && toolQueries.every((q) => q.data !== undefined);

  const [entries, setEntries] = useState<Map<string, PendingExclusionEntry>>(
    new Map(),
  );
  const [unresolvedToolIds, setUnresolvedToolIds] = useState<string[]>([]);
  // Round-trip-normalized baseline; null until initialization completes.
  const [initialPayload, setInitialPayload] =
    useState<AgentToolExclusions | null>(null);
  const initialized = initialPayload !== null;
  // The user's first manual edit freezes the (re)initialization effect below
  // so late query results or a seed-prop flip can't clobber their changes.
  const [userEdited, setUserEdited] = useState(false);

  // Track which pill should auto-open its popover after being added.
  const [autoOpenCatalogId, setAutoOpenCatalogId] = useState<string | null>(
    null,
  );

  // Client-computed default exclusion set (backend pre-fill mirror), applied
  // when seeding: every built-in tool that is neither assigned (saved
  // assignments, or the creation-default set for a new agent) nor exempt.
  const defaultExcludedToolIds = useMemo(() => {
    if (!seedDefaultExclusions) return [];
    // "Assigned" = the agent's saved assignments UNIONED with the tools editor's
    // live pending selection, so a built-in the user just checked in the Custom
    // tab (unsaved) is treated as assigned and not seeded as disabled.
    const assignedToolIds = new Set<string>([
      ...(agentId ? assignedTools.map((tool) => tool.id) : []),
      ...(pendingAssignedToolIds ?? []),
    ]);
    return computeDefaultExclusionToolIds({
      builtInTools: toolsByCatalog.get(ARCHESTRA_MCP_CATALOG_ID) ?? [],
      assignedToolIds,
      // New agent: the backend auto-assigns the creation-default set; protect it
      // by short name until the live selection reports those tool ids.
      ...(agentId
        ? {}
        : {
            assumedAssignedShortNames: new Set(
              getCreationDefaultArchestraToolShortNames({
                skillsEnabled: skillToolsEnabled,
                sandboxEnabled,
              }),
            ),
          }),
    });
  }, [
    seedDefaultExclusions,
    toolsByCatalog,
    agentId,
    assignedTools,
    pendingAssignedToolIds,
    skillToolsEnabled,
    sandboxEnabled,
  ]);

  // (Re)initialize pending state once loaded exclusions and the catalog tool
  // lists (needed to group tool ids into pills) are available. Until the user
  // first edits the entries, this keeps re-running so the seeded merge tracks
  // late-loading queries and a seed-prop flip (toggling the All/Custom tabs);
  // the seeded state is both the entries AND the baseline, so an untouched
  // seeded editor is not dirty and its save no-ops. The applied-key ref skips
  // re-runs whose computed state is unchanged.
  const appliedInitKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (userEdited) return;
    if (agentId && !exclusionsFetched) return;
    if (!allToolsLoaded) return;
    if (!seedInputsReady) return;
    const serverExclusions = loadedExclusions ?? EMPTY_EXCLUSIONS;
    const exclusions = seedDefaultExclusions
      ? mergeExclusionsWithDefaultToolIds({
          exclusions: serverExclusions,
          defaultExcludedToolIds,
        })
      : serverExclusions;
    const initKey = exclusionsKey(exclusions);
    if (appliedInitKeyRef.current === initKey) return;
    appliedInitKeyRef.current = initKey;
    const initial = buildInitialEntries({ exclusions, toolIdsByCatalog });
    setEntries(initial.entries);
    setUnresolvedToolIds(initial.unresolvedToolIds);
    setInitialPayload(
      buildExclusionPayload({
        entries: initial.entries.values(),
        unresolvedToolIds: initial.unresolvedToolIds,
      }),
    );
  }, [
    userEdited,
    agentId,
    exclusionsFetched,
    allToolsLoaded,
    seedInputsReady,
    loadedExclusions,
    toolIdsByCatalog,
    seedDefaultExclusions,
    defaultExcludedToolIds,
  ]);

  const currentPayload = useMemo(
    () =>
      buildExclusionPayload({
        entries: entries.values(),
        unresolvedToolIds,
      }),
    [entries, unresolvedToolIds],
  );

  // Report state upward keyed by content (the payload objects are rebuilt
  // every render, so identity can't drive the effect).
  const initialKey = initialPayload ? exclusionsKey(initialPayload) : null;
  const currentKey = exclusionsKey(currentPayload);
  const latestStateRef = useRef({
    initial: EMPTY_EXCLUSIONS,
    current: EMPTY_EXCLUSIONS,
  });
  latestStateRef.current = {
    initial: initialPayload ?? EMPTY_EXCLUSIONS,
    current: currentPayload,
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: initialKey/currentKey are content keys that re-fire the report when the payloads (rebuilt each render, read via ref) actually change
  useEffect(() => {
    if (!initialized) return;
    onStateChange?.(latestStateRef.current);
  }, [initialized, initialKey, currentKey, onStateChange]);
  useEffect(() => () => onStateChange?.(null), [onStateChange]);

  useImperativeHandle(ref, () => ({
    saveChanges: async (params) => {
      const targetAgentId = params?.agentId ?? agentId;
      if (!targetAgentId || !initialized) return;
      if (initialKey === currentKey) return;
      await updateExclusions.mutateAsync({
        agentId: targetAgentId,
        exclusions: currentPayload,
      });
      setInitialPayload(currentPayload);
    },
  }));

  const handleCatalogToggle = useCallback(
    (catalogId: string) => {
      setUserEdited(true);
      setEntries((prev) => {
        const next = new Map(prev);
        if (next.has(catalogId)) {
          next.delete(catalogId);
          return next;
        }
        // Adding a server excludes all of its excludable tools; the pill
        // checklist narrows that to a subset.
        next.set(catalogId, {
          catalogId,
          selectedToolIds: new Set(toolIdsByCatalog.get(catalogId) ?? []),
        });
        return next;
      });
    },
    [toolIdsByCatalog],
  );

  const handleSelectionChange = useCallback(
    (catalogId: string, selectedToolIds: Set<string>) => {
      setUserEdited(true);
      setEntries((prev) => {
        const next = new Map(prev);
        next.set(catalogId, { catalogId, selectedToolIds });
        return next;
      });
    },
    [],
  );

  const comboboxItems: AssignmentComboboxItem[] = useMemo(
    () =>
      catalogItems.map((catalog) => {
        const displayName =
          catalog.id === ARCHESTRA_MCP_CATALOG_ID ? catalogName : catalog.name;
        const totalCount = toolIdsByCatalog.get(catalog.id)?.length ?? 0;
        const entry = entries.get(catalog.id);
        const excludedCount = entry ? entry.selectedToolIds.size : 0;
        return {
          id: catalog.id,
          name: displayName,
          description: catalog.description || undefined,
          icon: (
            <McpCatalogIcon
              icon={catalog.icon}
              catalogId={catalog.id}
              size={16}
            />
          ),
          badge:
            excludedCount > 0
              ? `${excludedCount}/${totalCount} disabled`
              : undefined,
          disabled: totalCount === 0,
          disabledReason: totalCount === 0 ? "No tools to disable" : undefined,
        };
      }),
    [catalogItems, catalogName, toolIdsByCatalog, entries],
  );

  const excludedCatalogs = useMemo(
    () => catalogItems.filter((catalog) => entries.has(catalog.id)),
    [catalogItems, entries],
  );

  if (!initialized) {
    return (
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Loader2 className="h-3 w-3 animate-spin" />
        <span>Loading exclusions...</span>
      </div>
    );
  }

  return (
    <div className="flex flex-wrap gap-2">
      {excludedCatalogs.map((catalog) => {
        const entry = entries.get(catalog.id);
        if (!entry) return null;
        const tools = toolsByCatalog.get(catalog.id) ?? [];
        const checkedToolIds = entry.selectedToolIds;
        return (
          <ExclusionPill
            key={catalog.id}
            catalogItem={catalog}
            displayName={
              catalog.id === ARCHESTRA_MCP_CATALOG_ID
                ? catalogName
                : catalog.name
            }
            tools={tools}
            checkedToolIds={checkedToolIds}
            onSelectionChange={handleSelectionChange}
            onRemove={handleCatalogToggle}
            autoOpen={catalog.id === autoOpenCatalogId}
            onAutoOpened={() => setAutoOpenCatalogId(null)}
          />
        );
      })}
      <AssignmentCombobox
        items={comboboxItems}
        selectedIds={[...entries.keys()]}
        onToggle={handleCatalogToggle}
        onItemAdded={setAutoOpenCatalogId}
        label="Disable"
        placeholder="Search MCP servers..."
        emptyMessage="No MCP servers found."
      />
    </div>
  );
});

// === internal ===

interface ExclusionPillProps {
  catalogItem: InternalMcpCatalogItem;
  displayName: string;
  tools: CatalogTool[];
  checkedToolIds: Set<string>;
  onSelectionChange: (catalogId: string, selectedToolIds: Set<string>) => void;
  onRemove: (catalogId: string) => void;
  autoOpen?: boolean;
  onAutoOpened?: () => void;
}

function ExclusionPill({
  catalogItem,
  displayName,
  tools,
  checkedToolIds,
  onSelectionChange,
  onRemove,
  autoOpen,
  onAutoOpened,
}: ExclusionPillProps) {
  const [open, setOpen] = useState(false);

  // Auto-open the popover when the pill was just added from the combobox.
  useEffect(() => {
    if (autoOpen) {
      setOpen(true);
      onAutoOpened?.();
    }
  }, [autoOpen, onAutoOpened]);

  return (
    <Popover open={open} onOpenChange={setOpen} modal>
      <div className="flex items-center">
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            size="sm"
            className="h-8 rounded-r-none border-r-0 px-3 gap-1.5 text-xs"
          >
            <McpCatalogIcon
              icon={catalogItem.icon}
              catalogId={catalogItem.id}
              size={14}
            />
            <span className="font-medium">{displayName}</span>
            <span className="text-muted-foreground">
              {checkedToolIds.size}/{tools.length} disabled
            </span>
            <Pencil className="h-3 w-3 shrink-0 text-muted-foreground" />
          </Button>
        </PopoverTrigger>
        <Button
          variant="outline"
          size="sm"
          className="h-8 w-8 p-0 rounded-l-none"
          onClick={() => onRemove(catalogItem.id)}
          aria-label={`Re-enable all ${displayName} tools`}
        >
          <X className="h-3 w-3" />
        </Button>
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
            <p className="text-sm text-muted-foreground mt-1">
              Checked tools are disabled for this agent.
            </p>
          </div>
          <Button
            variant="ghost"
            size="sm"
            className="h-6 w-6 p-0 shrink-0"
            onClick={() => setOpen(false)}
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
        {tools.length === 0 ? (
          <div className="p-4 text-sm text-muted-foreground">
            No tools available for this server.
          </div>
        ) : (
          <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
            <ToolChecklist
              tools={tools}
              selectedToolIds={checkedToolIds}
              onSelectionChange={(ids) =>
                onSelectionChange(catalogItem.id, ids)
              }
              variant="disable"
            />
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
