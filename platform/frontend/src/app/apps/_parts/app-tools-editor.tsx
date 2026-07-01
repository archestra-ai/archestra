"use client";

import {
  ARCHESTRA_MCP_CATALOG_ID,
  type archestraApiTypes,
  isPlaywrightCatalogItem,
} from "@archestra/shared";
import { useQueries } from "@tanstack/react-query";
import { Trash2 } from "lucide-react";
import { useMemo } from "react";
import { ToolChecklist } from "@/components/agent-tools-editor";
import {
  isCatalogInEnvironment,
  sortCatalogItems,
} from "@/components/agent-tools-editor.utils";
import { LoadingWrapper } from "@/components/loading";
import { McpCatalogIcon } from "@/components/mcp-catalog-icon";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  useApp,
  useAppTools,
  useAssignToolToApp,
  useUnassignToolFromApp,
} from "@/lib/app.query";
import { useHasPermissions } from "@/lib/auth/auth.query";
import {
  fetchCatalogTools,
  useInternalMcpCatalog,
} from "@/lib/mcp/internal-mcp-catalog.query";
import { cn } from "@/lib/utils";

type CatalogItem =
  archestraApiTypes.GetInternalMcpCatalogResponses["200"][number];
type CatalogTool =
  archestraApiTypes.GetInternalMcpCatalogToolsResponses["200"][number];
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
  unbounded = false,
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
  /**
   * Let each server's tool list flow at its full height instead of capping it
   * at a scrollable `max-h-96` box. Set when embedding in a surface that already
   * scrolls (e.g. the inline settings form) so its wheel scroll isn't captured
   * by a nested scroller.
   */
  unbounded?: boolean;
}) {
  const { data: app } = useApp(appId);
  const { data: assigned, isPending } = useAppTools(appId);
  const { data: catalogs = [] } = useInternalMcpCatalog();
  const { data: canEdit } = useHasPermissions({ app: ["update"] });
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

  // Applies a per-catalog selection change: re-projects it onto the full
  // selection (controlled) or assigns/unassigns the delta live (uncontrolled).
  const changeCatalogSelection = (
    catalogTools: CatalogTool[],
    next: Set<string>,
  ) => {
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

  // Candidate servers: every one in the app's environment (Playwright is
  // environment-agnostic like a builtin), plus any server a current assignment
  // already references so it can be cleaned up. The Archestra builtin catalog is
  // never assignable.
  const candidates = useMemo(
    () =>
      catalogs.filter((c) => {
        if (c.id === ARCHESTRA_MCP_CATALOG_ID) return false;
        const inEnv =
          isPlaywrightCatalogItem(c.id) ||
          isCatalogInEnvironment(c, appEnvironmentId);
        return inEnv || assignedIdsByCatalog.has(c.id);
      }),
    [catalogs, appEnvironmentId, assignedIdsByCatalog],
  );

  // Editors get the interactive checklist, so load each candidate's tools to
  // group, count, and render them. Viewers only see assigned tools (below) and
  // don't fetch catalog tools.
  const toolQueries = useQueries({
    queries: candidates.map((c) => ({
      queryKey: ["mcp-catalog", c.id, "tools"] as const,
      queryFn: () => fetchCatalogTools(c.id),
      enabled: canEdit === true,
    })),
  });

  const toolsByCatalog = useMemo(() => {
    const map = new Map<string, CatalogTool[]>();
    candidates.forEach((c, i) => {
      map.set(c.id, (toolQueries[i]?.data as CatalogTool[] | undefined) ?? []);
    });
    return map;
  }, [candidates, toolQueries]);

  // Hide servers with no tools unless an assignment depends on them.
  const visibleCatalogs = useMemo(() => {
    const withTools = candidates.filter(
      (c) =>
        (toolsByCatalog.get(c.id)?.length ?? 0) > 0 ||
        assignedIdsByCatalog.has(c.id),
    );
    return sortCatalogItems(
      withTools,
      (c) => assignedIdsByCatalog.get(c.id)?.size ?? 0,
      (c) => toolsByCatalog.get(c.id)?.length ?? 0,
    );
  }, [candidates, toolsByCatalog, assignedIdsByCatalog]);

  const defaultOpen = useMemo(
    () =>
      visibleCatalogs
        .filter((c) => assignedIdsByCatalog.has(c.id))
        .map((c) => c.id),
    [visibleCatalogs, assignedIdsByCatalog],
  );

  // Assigned tools that map to no listed catalog (server removed, or the
  // catalog list failed/has not loaded) would otherwise be invisible and
  // unremovable in the grouped view; surface them as a removable fallback.
  const orphanedAssigned = useMemo(() => {
    const catalogIds = new Set(catalogs.map((c) => c.id));
    return (assigned ?? []).filter(
      (t) => !t.catalogId || !catalogIds.has(t.catalogId),
    );
  }, [assigned, catalogs]);

  // Only surface orphans still in the (possibly staged) selection so removing
  // one in controlled mode hides it immediately.
  const orphanedVisible = useMemo(
    () => orphanedAssigned.filter((t) => selection.has(t.id)),
    [orphanedAssigned, selection],
  );

  const toolsLoading = toolQueries.some((q) => q.isLoading);

  if (canEdit !== true) {
    return (
      <AssignedToolsReadOnly
        isPending={isPending && !assigned}
        assigned={assigned ?? []}
        catalogs={catalogs}
      />
    );
  }

  return (
    <div className="flex max-w-2xl flex-col gap-4">
      <LoadingWrapper isPending={isPending && !assigned}>
        {visibleCatalogs.length === 0 && orphanedVisible.length === 0 ? (
          candidates.length > 0 && toolsLoading ? (
            <p className="text-sm text-muted-foreground">Loading tools…</p>
          ) : (
            <p className="text-sm text-muted-foreground">
              No MCP servers are available in this app's environment. The app
              can still use its data store.
            </p>
          )
        ) : (
          <>
            {visibleCatalogs.length > 0 ? (
              <Accordion type="multiple" defaultValue={defaultOpen}>
                {visibleCatalogs.map((catalog) => {
                  const catalogTools =
                    toolsByCatalog.get(catalog.id) ?? EMPTY_TOOLS;
                  // A selected id belongs to this catalog if its tool is loaded
                  // here or it's a persisted assignment of this catalog — the
                  // latter keeps the count correct before catalog tools load.
                  const catalogToolIds = new Set(catalogTools.map((t) => t.id));
                  const persistedInCatalog =
                    assignedIdsByCatalog.get(catalog.id) ?? new Set<string>();
                  const selectedInCatalog = new Set(
                    [...selection].filter(
                      (id) =>
                        catalogToolIds.has(id) || persistedInCatalog.has(id),
                    ),
                  );
                  const outOfEnv =
                    !isPlaywrightCatalogItem(catalog.id) &&
                    !isCatalogInEnvironment(catalog, appEnvironmentId);
                  return (
                    <AccordionItem key={catalog.id} value={catalog.id}>
                      <AccordionTrigger>
                        <div className="flex w-full items-center gap-2 pr-2">
                          <McpCatalogIcon
                            icon={catalog.icon}
                            catalogId={catalog.id}
                            size={20}
                          />
                          <span className="truncate font-medium">
                            {catalog.name}
                          </span>
                          {outOfEnv ? (
                            <span className="shrink-0 text-xs font-normal text-muted-foreground">
                              (outside this environment)
                            </span>
                          ) : null}
                          {selectedInCatalog.size > 0 ? (
                            <Badge variant="secondary" className="ml-auto">
                              {selectedInCatalog.size} selected
                            </Badge>
                          ) : null}
                        </div>
                      </AccordionTrigger>
                      <AccordionContent>
                        <div
                          className={cn(
                            "flex flex-col rounded-md border",
                            !unbounded && "max-h-96",
                          )}
                        >
                          <AppCatalogToolList
                            tools={catalogTools}
                            selectedToolIds={selectedInCatalog}
                            onSelectionChange={(next) =>
                              changeCatalogSelection(catalogTools, next)
                            }
                          />
                        </div>
                      </AccordionContent>
                    </AccordionItem>
                  );
                })}
              </Accordion>
            ) : null}
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
              size="icon"
              className="h-8 w-8 text-muted-foreground hover:text-destructive"
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

function AppCatalogToolList({
  tools,
  selectedToolIds,
  onSelectionChange,
}: {
  tools: CatalogTool[];
  selectedToolIds: Set<string>;
  onSelectionChange: (next: Set<string>) => void;
}) {
  if (tools.length === 0) {
    return (
      <p className="px-4 py-3 text-sm text-muted-foreground">
        This server exposes no tools yet.
      </p>
    );
  }

  return (
    <ToolChecklist
      tools={tools}
      selectedToolIds={selectedToolIds}
      onSelectionChange={onSelectionChange}
    />
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
