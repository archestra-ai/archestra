"use client";

import {
  ARCHESTRA_MCP_CATALOG_ID,
  type archestraApiTypes,
  isPlaywrightCatalogItem,
  PLAYWRIGHT_MCP_CATALOG_ID,
} from "@archestra/shared";
import { useQueries, useQueryClient } from "@tanstack/react-query";
import { Trash2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { ToolChecklist } from "@/components/agent-tools-editor";
import {
  isCatalogInAppEnvironment,
  setsEqual,
  sortCatalogItems,
} from "@/components/agent-tools-editor.utils";
import { LoadingWrapper } from "@/components/loading";
import { McpCatalogIcon } from "@/components/mcp-catalog-icon";
import { McpServerPillShell } from "@/components/mcp-server-pill-shell";
import {
  AssignmentCombobox,
  type AssignmentComboboxItem,
} from "@/components/ui/assignment-combobox";
import { Button } from "@/components/ui/button";
import {
  useApp,
  useAppTools,
  useAssignToolToApp,
  useUnassignToolFromApp,
} from "@/lib/app.query";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { useDebouncedValue } from "@/lib/hooks/use-debounced-value";
import { fetchCatalogTools } from "@/lib/mcp/internal-mcp-catalog.query";
import {
  type McpRegistryRow,
  useMcpRegistryPage,
  useMcpRegistryRowsByIds,
} from "@/lib/mcp/mcp-registry.query";

/** A catalog item as the editor reads it: its registry row. */
type CatalogItem = McpRegistryRow;
type CatalogTool = Pick<
  archestraApiTypes.GetInternalMcpCatalogToolsResponses["200"][number],
  "id" | "name" | "description" | "createdAt" | "group"
>;
type AssignedTool = archestraApiTypes.GetAppToolsResponses["200"][number];

const EMPTY_TOOLS: CatalogTool[] = [];

/**
 * An app's assignable upstream tools, grouped by their MCP server (catalog) to
 * mirror the agent tool selector. Assignment uses dynamic credentials (resolved
 * per viewer at call time) — the only resolution mode that fits an app shared
 * across an org. Built-in Archestra tools (incl. the always-available App Data
 * Store) aren't assignable and are omitted. Only servers in the app's bound
 * environment are offered; a server an existing assignment has left is still
 * shown so the stale assignment can be removed.
 */
export function AppToolsEditor({
  appId,
  environmentId,
  selectedToolIds,
  onSelectionChange,
  readOnly = false,
}: {
  appId: string;
  /**
   * Overrides the app's persisted environment for filtering candidate servers —
   * lets a caller preview the tools available under a not-yet-saved environment
   * (e.g. the settings dialog stages environment + tools and saves them as a
   * pair). Omit to filter by the app's saved environment.
   */
  environmentId?: string | null;
  /**
   * Controlled selection. When both this and {@link onSelectionChange} are set,
   * the editor is a staged selector: toggles call `onSelectionChange` instead of
   * assigning/unassigning immediately. Omit both for the live editor that
   * persists each toggle through the Apps API.
   */
  selectedToolIds?: Set<string>;
  onSelectionChange?: (next: Set<string>) => void;
  /** Force the assigned-tools summary even when the caller has app:update. */
  readOnly?: boolean;
}) {
  const { data: app } = useApp(environmentId === undefined ? appId : null);
  const { data: assigned, isPending } = useAppTools(appId);
  const { data: hasUpdatePermission } = useHasPermissions(
    { app: ["update"] },
    appId,
  );
  const canEdit = hasUpdatePermission === true && !readOnly;
  const queryClient = useQueryClient();
  const assignTool = useAssignToolToApp();
  const unassignTool = useUnassignToolFromApp();

  const controlled =
    selectedToolIds !== undefined && onSelectionChange !== undefined;
  const appEnvironmentId =
    environmentId !== undefined ? environmentId : (app?.environmentId ?? null);

  // The effective selection drives the checkboxes and counts: the staged set in
  // controlled mode, otherwise the app's persisted assignments.
  const selection = useMemo(
    () =>
      controlled
        ? (selectedToolIds ?? new Set<string>())
        : new Set((assigned ?? []).map((t) => t.id)),
    [controlled, selectedToolIds, assigned],
  );

  // The selection as of the latest render: a change applied after an await
  // (adding a server waits for its tools) must not overwrite a change made
  // meanwhile with the selection it started from.
  const selectionRef = useRef(selection);
  selectionRef.current = selection;

  // Applies a per-catalog selection change: re-projects it onto the full
  // selection (controlled) or assigns/unassigns the delta live (uncontrolled).
  const changeCatalogSelection = (
    catalogTools: CatalogTool[],
    next: Set<string>,
  ) => {
    const selection = selectionRef.current;
    if (controlled) {
      const merged = new Set(selection);
      for (const t of catalogTools) merged.delete(t.id);
      for (const id of next) merged.add(id);
      onSelectionChange?.(merged);
      return;
    }
    for (const id of next) {
      if (!selection.has(id)) {
        assignTool.mutate({
          appId,
          toolId: id,
          body: { credentialResolutionMode: "dynamic" },
        });
      }
    }
    for (const t of catalogTools) {
      if (selection.has(t.id) && !next.has(t.id)) {
        unassignTool.mutate({ appId, toolId: t.id });
      }
    }
  };

  // Removes an orphaned tool: drops it from the staged set (controlled) or
  // unassigns it live (uncontrolled).
  const removeTool = (toolId: string) => {
    if (controlled) {
      const merged = new Set(selection);
      merged.delete(toolId);
      onSelectionChange?.(merged);
      return;
    }
    unassignTool.mutate({ appId, toolId });
  };

  const assignedIdsByCatalog = useMemo(() => {
    const map = new Map<string, Set<string>>();
    for (const tool of assigned ?? []) {
      if (!tool.catalogId) continue;
      let set = map.get(tool.catalogId);
      if (!set) {
        set = new Set();
        map.set(tool.catalogId, set);
      }
      set.add(tool.id);
    }
    return map;
  }, [assigned]);

  // A pill stays visible while a server is added this session, even if the user
  // then deselects all its tools inside the popover (mirrors the gateway).
  const [activeCatalogIds, setActiveCatalogIds] = useState<Set<string>>(
    () => new Set(),
  );

  // The rows this editor shows, without the whole registry: the servers the
  // app's tools come from (and Playwright, offered everywhere), by id, plus
  // one page of the servers in the app's environment or the Default one,
  // searched on the server as the reader types.
  const assignedCatalogIds = useMemo(
    () => [...assignedIdsByCatalog.keys(), PLAYWRIGHT_MCP_CATALOG_ID],
    [assignedIdsByCatalog],
  );
  const assignedCatalogRows = useMcpRegistryRowsByIds(assignedCatalogIds, {
    includeBuiltIn: true,
  });
  const [catalogSearch, setCatalogSearch] = useState("");
  const debouncedCatalogSearch = useDebouncedValue(catalogSearch.trim(), 250);
  const catalogPage = useMcpRegistryPage(
    {
      environmentIds: appEnvironmentId ? [appEnvironmentId] : [],
      includeDefaultEnvironment: true,
      ...(debouncedCatalogSearch ? { search: debouncedCatalogSearch } : {}),
      sortBy: "name",
      sortDirection: "asc",
      limit: CATALOG_PAGE_SIZE,
      offset: 0,
    },
    { enabled: canEdit, placeholderScope: "app-tools-editor" },
  );
  const isCatalogSearching =
    catalogSearch.trim() !== debouncedCatalogSearch ||
    (!!debouncedCatalogSearch && catalogPage.isFetching);
  // Rows picked from the list this session. Picking closes the list, which
  // clears its search, so a server found on a searched page would otherwise
  // drop out of the editor together with its pill and staged tools.
  const [pickedRows, setPickedRows] = useState<Map<string, CatalogItem>>(
    () => new Map(),
  );
  const catalogs = useMemo(() => {
    const byId = new Map<string, CatalogItem>();
    for (const row of assignedCatalogRows.data) byId.set(row.id, row);
    for (const [id, row] of pickedRows) {
      if (!byId.has(id)) byId.set(id, row);
    }
    for (const row of catalogPage.data?.data ?? []) {
      if (!byId.has(row.id)) byId.set(row.id, row);
    }
    return [...byId.values()];
  }, [assignedCatalogRows.data, pickedRows, catalogPage.data]);

  // Candidate servers: every one in the app's environment or the Default
  // baseline apps may always draw from (Playwright is environment-agnostic
  // like a builtin), plus any server a current assignment already references
  // so it can be cleaned up. The Archestra builtin catalog is never
  // assignable.
  const candidates = useMemo(
    () =>
      catalogs.filter((c) => {
        if (c.id === ARCHESTRA_MCP_CATALOG_ID) return false;
        const inEnv =
          isPlaywrightCatalogItem(c.id) ||
          isCatalogInAppEnvironment(c, appEnvironmentId);
        return inEnv || assignedIdsByCatalog.has(c.id);
      }),
    [catalogs, appEnvironmentId, assignedIdsByCatalog],
  );

  // Editors get the interactive checklist, so load the tools of the servers
  // shown as pills (those the app uses and those just added); the Add list
  // counts from each row's tool count. Viewers only see assigned tools
  // (below) and don't fetch catalog tools.
  const pillCandidates = useMemo(
    () =>
      candidates.filter(
        (c) => assignedIdsByCatalog.has(c.id) || activeCatalogIds.has(c.id),
      ),
    [candidates, assignedIdsByCatalog, activeCatalogIds],
  );
  const toolQueries = useQueries({
    queries: pillCandidates.map((c) => catalogToolsQuery(c.id, canEdit)),
  });

  const toolsByCatalog = useMemo(() => {
    const map = new Map<string, CatalogTool[]>();
    pillCandidates.forEach((c, i) => {
      map.set(c.id, (toolQueries[i]?.data as CatalogTool[] | undefined) ?? []);
    });
    return map;
  }, [pillCandidates, toolQueries]);

  // Hide servers with no tools unless an assignment depends on them.
  const visibleCatalogs = useMemo(() => {
    const withTools = candidates.filter(
      (c) => c.toolCount > 0 || assignedIdsByCatalog.has(c.id),
    );
    return sortCatalogItems(
      withTools,
      (c) => assignedIdsByCatalog.get(c.id)?.size ?? 0,
      (c) => c.toolCount,
    );
  }, [candidates, assignedIdsByCatalog]);

  // Assigned tools that map to no listed catalog (server removed, or the
  // catalog list failed/has not loaded) would otherwise be invisible and
  // unremovable in the grouped view; surface them as a removable fallback.
  const orphanedAssigned = useMemo(() => {
    // Until the app's own servers are read, none of its tools is an orphan.
    if (assignedCatalogRows.isPending) return [];
    const catalogIds = new Set(assignedCatalogRows.data.map((c) => c.id));
    return (assigned ?? []).filter(
      (t) => !t.catalogId || !catalogIds.has(t.catalogId),
    );
  }, [assigned, assignedCatalogRows.isPending, assignedCatalogRows.data]);

  // Only surface orphans still in the (possibly staged) selection so removing
  // one in controlled mode hides it immediately.
  const orphanedVisible = useMemo(
    () => orphanedAssigned.filter((t) => selection.has(t.id)),
    [orphanedAssigned, selection],
  );

  // The pill whose popover should pop open right after it's added.
  const [autoOpenCatalogId, setAutoOpenCatalogId] = useState<string | null>(
    null,
  );

  // Selected tool ids grouped by their catalog. A selected id belongs to a
  // catalog if its tool is loaded there or it's a persisted assignment of it —
  // the latter keeps the count right before catalog tools load.
  const selectedByCatalog = useMemo(() => {
    const map = new Map<string, Set<string>>();
    for (const catalog of visibleCatalogs) {
      const catalogTools = toolsByCatalog.get(catalog.id) ?? EMPTY_TOOLS;
      const catalogToolIds = new Set(catalogTools.map((t) => t.id));
      const persisted =
        assignedIdsByCatalog.get(catalog.id) ?? new Set<string>();
      map.set(
        catalog.id,
        new Set(
          [...selection].filter(
            (id) => catalogToolIds.has(id) || persisted.has(id),
          ),
        ),
      );
    }
    return map;
  }, [visibleCatalogs, toolsByCatalog, assignedIdsByCatalog, selection]);

  // Pilled servers: those with a selection, plus ones just added and not yet
  // removed. Sorted (assigned first) via visibleCatalogs.
  const shownCatalogs = useMemo(
    () =>
      visibleCatalogs.filter(
        (c) =>
          (selectedByCatalog.get(c.id)?.size ?? 0) > 0 ||
          activeCatalogIds.has(c.id),
      ),
    [visibleCatalogs, selectedByCatalog, activeCatalogIds],
  );
  const shownCatalogIds = useMemo(
    () => shownCatalogs.map((c) => c.id),
    [shownCatalogs],
  );

  // Add a server (select all its tools) or remove it (clear all its tools),
  // toggled from the "+ Add" combobox or the pill's remove button.
  const toggleCatalog = async (catalogId: string) => {
    const catalog = candidates.find((c) => c.id === catalogId);
    if (!catalog) return;
    const shown =
      (selectedByCatalog.get(catalogId)?.size ?? 0) > 0 ||
      activeCatalogIds.has(catalogId);
    // Keep the row before waiting for its tools: the list's search clears as
    // soon as the menu closes.
    if (!shown) setPickedRows((prev) => new Map(prev).set(catalogId, catalog));
    const catalogTools =
      toolsByCatalog.get(catalogId) ??
      // A server added from the list: its tools load as it is added.
      ((await queryClient.fetchQuery(
        catalogToolsQuery(catalogId, true),
      )) as CatalogTool[]);
    if (shown) {
      changeCatalogSelection(catalogTools, new Set());
      setActiveCatalogIds((prev) => {
        const next = new Set(prev);
        next.delete(catalogId);
        return next;
      });
      setPickedRows((prev) => {
        const next = new Map(prev);
        next.delete(catalogId);
        return next;
      });
    } else {
      // Staged mode pre-selects every tool (nothing persists until Save). Live
      // mode leaves them unselected: a burst of assign mutations here, followed
      // by a quick remove, would derive its unassigns from a not-yet-refetched
      // selection and strand the grants — so the user picks tools in the popover
      // instead, one assignment at a time.
      if (controlled) {
        changeCatalogSelection(
          catalogTools,
          new Set(catalogTools.map((t) => t.id)),
        );
      }
      setActiveCatalogIds((prev) => new Set(prev).add(catalogId));
    }
  };

  const comboboxItems: AssignmentComboboxItem[] = useMemo(
    () =>
      candidates.map((catalog) => {
        const total = catalog.toolCount;
        const selected = selectedByCatalog.get(catalog.id)?.size ?? 0;
        const disabled = total === 0;
        return {
          id: catalog.id,
          name: catalog.name,
          description: catalog.description || undefined,
          icon: (
            <McpCatalogIcon
              icon={catalog.iconUrl ?? catalog.icon}
              catalogId={catalog.id}
              size={16}
            />
          ),
          badge: disabled
            ? undefined
            : selected > 0
              ? `${selected}/${total}`
              : `${total} tools`,
          disabled,
          disabledReason: disabled ? "No tools" : undefined,
        };
      }),
    [candidates, selectedByCatalog],
  );

  if (!canEdit) {
    return (
      <AssignedToolsReadOnly
        isPending={isPending && !assigned}
        assigned={assigned ?? []}
        catalogs={assignedCatalogRows.data}
      />
    );
  }

  return (
    <div className="flex max-w-2xl flex-col gap-4">
      <LoadingWrapper isPending={isPending && !assigned}>
        {candidates.length === 0 && orphanedVisible.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No MCP servers are available in this app's environment. The app can
            still use its data store.
          </p>
        ) : (
          <>
            <div className="flex flex-wrap gap-2">
              {shownCatalogs.map((catalog) => {
                const catalogTools =
                  toolsByCatalog.get(catalog.id) ?? EMPTY_TOOLS;
                const selectedInCatalog =
                  selectedByCatalog.get(catalog.id) ?? new Set<string>();
                const persistedInCatalog =
                  assignedIdsByCatalog.get(catalog.id) ?? new Set<string>();
                const outOfEnv =
                  !isPlaywrightCatalogItem(catalog.id) &&
                  !isCatalogInAppEnvironment(catalog, appEnvironmentId);
                return (
                  <AppMcpServerPill
                    key={catalog.id}
                    catalog={catalog}
                    tools={catalogTools}
                    selectedToolIds={selectedInCatalog}
                    highlighted={
                      !setsEqual(selectedInCatalog, persistedInCatalog)
                    }
                    note={outOfEnv ? "(outside this environment)" : undefined}
                    onSelectionChange={(next) =>
                      changeCatalogSelection(catalogTools, next)
                    }
                    onRemove={() => void toggleCatalog(catalog.id)}
                    autoOpen={catalog.id === autoOpenCatalogId}
                    onAutoOpened={() => setAutoOpenCatalogId(null)}
                  />
                );
              })}
              <AssignmentCombobox
                items={comboboxItems}
                selectedIds={shownCatalogIds}
                onToggle={(catalogId) => void toggleCatalog(catalogId)}
                onItemAdded={setAutoOpenCatalogId}
                onSearchChange={setCatalogSearch}
                isSearching={isCatalogSearching}
                placeholder="Search MCP servers..."
                emptyMessage="No MCP servers found."
                createAction={{
                  label: "Install New MCP Server",
                  href: "/mcp/registry",
                }}
              />
            </div>
            {orphanedVisible.length > 0 ? (
              <OrphanedAssignedTools
                tools={orphanedVisible}
                onRemove={removeTool}
              />
            ) : null}
          </>
        )}
      </LoadingWrapper>
    </div>
  );
}

function OrphanedAssignedTools({
  tools,
  onRemove,
}: {
  tools: AssignedTool[];
  onRemove: (toolId: string) => void;
}) {
  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs text-muted-foreground">
        Other assigned tools, not part of a listed MCP server.
      </p>
      <ul className="divide-y rounded-lg border">
        {tools.map((tool) => (
          <li
            key={tool.id}
            className="flex items-center justify-between gap-2 px-4 py-3"
          >
            <div className="min-w-0">
              <div className="truncate text-sm font-medium">{tool.name}</div>
              {tool.description ? (
                <div className="truncate text-xs text-muted-foreground">
                  {tool.description}
                </div>
              ) : null}
            </div>
            <Button
              variant="ghost"
              size="icon-sm"
              className="text-muted-foreground hover:text-destructive"
              aria-label={`Remove ${tool.name}`}
              onClick={() => onRemove(tool.id)}
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          </li>
        ))}
      </ul>
    </div>
  );
}

// One MCP server as a pill: the shared visual shell (trigger + popover chrome)
// wrapping this app's tool checklist. Fully controlled by the parent's selection
// — toggling a tool routes straight back through `onSelectionChange`.
function AppMcpServerPill({
  catalog,
  tools,
  selectedToolIds,
  highlighted,
  note,
  onSelectionChange,
  onRemove,
  autoOpen,
  onAutoOpened,
}: {
  catalog: CatalogItem;
  tools: CatalogTool[];
  selectedToolIds: Set<string>;
  highlighted: boolean;
  note?: string;
  onSelectionChange: (next: Set<string>) => void;
  onRemove: () => void;
  autoOpen: boolean;
  onAutoOpened: () => void;
}) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (autoOpen) {
      setOpen(true);
      onAutoOpened();
    }
  }, [autoOpen, onAutoOpened]);

  return (
    <McpServerPillShell
      icon={
        <McpCatalogIcon
          icon={catalog.iconUrl ?? catalog.icon}
          catalogId={catalog.id}
          size={14}
        />
      }
      displayName={catalog.name}
      count={selectedToolIds.size}
      isEmpty={selectedToolIds.size === 0}
      highlighted={highlighted}
      note={note}
      description={catalog.description}
      docsUrl={catalog.docsUrl}
      open={open}
      onOpenChange={setOpen}
      onRemove={onRemove}
      removeAriaLabel={`Remove ${catalog.name}`}
    >
      {tools.length === 0 ? (
        <p className="p-4 text-sm text-muted-foreground">
          This server exposes no tools yet.
        </p>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          <ToolChecklist
            tools={tools}
            selectedToolIds={selectedToolIds}
            onSelectionChange={onSelectionChange}
          />
        </div>
      )}
    </McpServerPillShell>
  );
}

function AssignedToolsReadOnly({
  isPending,
  assigned,
  catalogs,
}: {
  isPending: boolean;
  assigned: AssignedTool[];
  catalogs: CatalogItem[];
}) {
  const catalogNameById = useMemo(
    () => new Map(catalogs.map((c) => [c.id, c.name])),
    [catalogs],
  );

  return (
    <div className="flex max-w-2xl flex-col gap-4">
      <LoadingWrapper isPending={isPending}>
        {assigned.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No tools assigned. The app can still use its data store.
          </p>
        ) : (
          <ul className="divide-y rounded-lg border">
            {assigned.map((tool) => (
              <li key={tool.id} className="px-4 py-3">
                <div className="truncate text-sm font-medium">{tool.name}</div>
                {tool.catalogId && catalogNameById.has(tool.catalogId) ? (
                  <div className="text-xs text-muted-foreground">
                    {catalogNameById.get(tool.catalogId)}
                  </div>
                ) : null}
                {tool.description ? (
                  <div className="truncate text-xs text-muted-foreground">
                    {tool.description}
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </LoadingWrapper>
    </div>
  );
}

/** Registry rows the Add list shows at a time; a search narrows on the server. */
const CATALOG_PAGE_SIZE = 50;

function catalogToolsQuery(catalogId: string, enabled: boolean) {
  return {
    queryKey: ["mcp-catalog", catalogId, "tools", "picker"] as const,
    queryFn: () => fetchCatalogTools(catalogId),
    enabled,
  };
}
