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
export function AppToolsTab({ appId }: { appId: string }) {
  const { data: app } = useApp(appId);
  const { data: assigned, isPending } = useAppTools(appId);
  const { data: catalogs = [] } = useInternalMcpCatalog();
  const { data: canEdit } = useHasPermissions({ app: ["update"] });

  const appEnvironmentId = app?.environmentId ?? null;

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
        {visibleCatalogs.length === 0 && orphanedAssigned.length === 0 ? (
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
                  const assignedCount =
                    assignedIdsByCatalog.get(catalog.id)?.size ?? 0;
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
                          {assignedCount > 0 ? (
                            <Badge variant="secondary" className="ml-auto">
                              {assignedCount} selected
                            </Badge>
                          ) : null}
                        </div>
                      </AccordionTrigger>
                      <AccordionContent>
                        <div className="flex max-h-96 flex-col rounded-md border">
                          <AppCatalogToolList
                            appId={appId}
                            tools={
                              toolsByCatalog.get(catalog.id) ?? EMPTY_TOOLS
                            }
                            assignedToolIds={
                              assignedIdsByCatalog.get(catalog.id) ?? null
                            }
                          />
                        </div>
                      </AccordionContent>
                    </AccordionItem>
                  );
                })}
              </Accordion>
            ) : null}
            {orphanedAssigned.length > 0 ? (
              <OrphanedAssignedTools appId={appId} tools={orphanedAssigned} />
            ) : null}
          </>
        )}
      </LoadingWrapper>
    </div>
  );
}

function OrphanedAssignedTools({
  appId,
  tools,
}: {
  appId: string;
  tools: AssignedTool[];
}) {
  const unassignTool = useUnassignToolFromApp();

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
              onClick={() => unassignTool.mutate({ appId, toolId: tool.id })}
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
  appId,
  tools,
  assignedToolIds,
}: {
  appId: string;
  tools: CatalogTool[];
  assignedToolIds: Set<string> | null;
}) {
  const assignTool = useAssignToolToApp();
  const unassignTool = useUnassignToolFromApp();

  const selectedToolIds = useMemo(
    () => new Set(assignedToolIds ?? []),
    [assignedToolIds],
  );

  // ToolChecklist emits the full next selection; assign/unassign only the delta.
  // Each mutation invalidates the app's tools query, so the checkboxes track
  // server state rather than optimistic local state.
  const handleSelectionChange = (next: Set<string>) => {
    for (const id of next) {
      if (!selectedToolIds.has(id)) {
        assignTool.mutate({
          appId,
          toolId: id,
          body: { credentialResolutionMode: "dynamic" },
        });
      }
    }
    for (const id of selectedToolIds) {
      if (!next.has(id)) {
        unassignTool.mutate({ appId, toolId: id });
      }
    }
  };

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
      onSelectionChange={handleSelectionChange}
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
