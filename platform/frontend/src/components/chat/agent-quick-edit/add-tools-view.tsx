"use client";

import {
  ARCHESTRA_MCP_CATALOG_ID,
  type archestraApiTypes,
} from "@archestra/shared";
import { useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  Check,
  Circle,
  ExternalLink,
  Loader2,
  Search,
} from "lucide-react";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { LocalServerInstallDialog } from "@/app/mcp/registry/_parts/local-server-install-dialog";
import { NoAuthInstallDialog } from "@/app/mcp/registry/_parts/no-auth-install-dialog";
import { RemoteServerInstallDialog } from "@/app/mcp/registry/_parts/remote-server-install-dialog";
import { McpCatalogIcon } from "@/components/mcp-catalog-icon";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  InlineNotice,
  InlineNoticeBody,
  InlineNoticeText,
} from "@/components/ui/inline-notice";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import {
  ServerToolsUpdateError,
  useAllProfileTools,
  useUpdateAgentServerTools,
} from "@/lib/agent-tools.query";
import { useDebouncedValue } from "@/lib/hooks/use-debounced-value";
import { useArchestraMcpIdentity } from "@/lib/mcp/archestra-mcp-server";
import { isInstallInProgress } from "@/lib/mcp/install-status";
import { fetchCatalogTools } from "@/lib/mcp/internal-mcp-catalog.query";
import type { McpInstallOrchestrator } from "@/lib/mcp/mcp-install-orchestrator.hook";
import {
  fetchInternalMcpCatalogItem,
  type McpRegistryRow,
  useMcpRegistryPage,
} from "@/lib/mcp/mcp-registry.query";
import {
  useMcpServers,
  useMcpServersGroupedByCatalog,
} from "@/lib/mcp/mcp-server.query";
import { cn } from "@/lib/utils/tailwind";
import type { QuickEditNotice } from "./settings-view";
import { QuickEditFooter, QuickEditViewHeader } from "./view-header";

type CatalogItem =
  archestraApiTypes.GetInternalMcpCatalogResponses["200"][number];

export function AddToolsView({
  agentId,
  agentName,
  installer,
  onBack,
  onChooseTools,
  onConnect,
  onAdded,
  onFailed,
}: {
  agentId: string;
  agentName: string;
  installer: McpInstallOrchestrator;
  onBack: () => void;
  onChooseTools: (catalog: CatalogItem) => void;
  /** Connect inside the dialog; servers that sign in by redirect use the modal. */
  onConnect: (catalog: CatalogItem) => void;
  onAdded: (catalogId: string) => void;
  onFailed: (notice: QuickEditNotice) => void;
}) {
  const queryClient = useQueryClient();
  const { data: assignedToolsData } = useAllProfileTools({
    filters: { agentId },
    skipPagination: true,
    includeToolDetails: false,
    enabled: !!agentId,
  });
  const { catalogName: builtInCatalogName } = useArchestraMcpIdentity();
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<"all" | "connected" | "not-connected">(
    "all",
  );
  const addAll = useAddAllServerTools({ agentId, agentName });

  // One page of the registry, searched and filtered on the server, with the
  // built-in entry; the counts on the filter come from the same query's
  // totals. Rows carry what this view shows (description, tool count, what
  // connecting asks for); an action loads the full item by id.
  const debouncedSearch = useDebouncedValue(search.trim(), 250);
  const baseQuery = {
    includeBuiltIn: true,
    ...(debouncedSearch
      ? { search: debouncedSearch, searchDescriptions: true }
      : {}),
    sortBy: "name" as const,
    sortDirection: "asc" as const,
  };
  const [pollWhileInstalling, setPollWhileInstalling] = useState(false);
  const page = useMcpRegistryPage(
    {
      ...baseQuery,
      ...(filter === "all"
        ? {}
        : {
            installState:
              filter === "connected"
                ? ("installed" as const)
                : ("not-installed" as const),
          }),
      limit: ADD_TOOLS_PAGE_SIZE,
      offset: 0,
    },
    {
      placeholderScope: `add-tools:${filter}`,
      // Until an install finishes deploying, so its row turns ready.
      refetchInterval: pollWhileInstalling ? 2_000 : false,
    },
  );
  // The counts on the filter come from their own queries, on every tab, so a
  // tab's label does not change while that tab's page loads; each keeps its
  // last total across a search until the new one answers.
  const allTotal = useMcpRegistryPage(
    { ...baseQuery, limit: 1, offset: 0 },
    { placeholderScope: "add-tools:total" },
  ).data?.pagination.total;
  const connectedTotal = useMcpRegistryPage(
    { ...baseQuery, installState: "installed", limit: 1, offset: 0 },
    { placeholderScope: "add-tools:connected" },
  ).data?.pagination.total;
  // The built-in entry is ready to add without an install, but the server
  // never counts it as installed: whether the search matches it decides the
  // Connected count, and the Connected tab lists it next to the installed
  // servers.
  const builtInPage = useMcpRegistryPage(
    {
      ...baseQuery,
      catalogIds: [ARCHESTRA_MCP_CATALOG_ID],
      limit: 1,
      offset: 0,
    },
    { placeholderScope: "add-tools:built-in" },
  ).data;
  const builtInRow = builtInPage?.data[0];
  const isPending = page.isPending;
  const pageRows = useMemo(() => {
    const listed = page.data?.data ?? [];
    if (filter === "connected") {
      return builtInRow ? [builtInRow, ...listed] : listed;
    }
    if (filter === "not-connected") {
      return listed.filter((row) => row.id !== ARCHESTRA_MCP_CATALOG_ID);
    }
    return listed;
  }, [page.data, filter, builtInRow]);
  const pageInstalls = page.data?.installs ?? [];

  const assignedCatalogIds = useMemo(() => {
    const ids = new Set<string>();
    for (const assignment of assignedToolsData?.data ?? []) {
      if (assignment.tool.catalogId) ids.add(assignment.tool.catalogId);
    }
    return ids;
  }, [assignedToolsData]);

  const rows = useMemo(
    () =>
      pageRows.map((catalog) => {
        const installing = pageInstalls.some(
          (server) =>
            server.catalogId === catalog.id &&
            isInstallInProgress(server.localInstallationStatus),
        );
        // One rule for rows, tabs and counts: connected means the viewer can
        // use an install (what the server's "installed" filter matches), so
        // its tools can be added to the agent.
        const connected =
          catalog.serverType === "builtin" ||
          (catalog.install.installedForViewer && !installing);
        return {
          catalog,
          name:
            catalog.id === ARCHESTRA_MCP_CATALOG_ID
              ? builtInCatalogName
              : catalog.name,
          connected,
          installing,
          assigned: assignedCatalogIds.has(catalog.id),
        };
      }),
    [pageRows, pageInstalls, assignedCatalogIds, builtInCatalogName],
  );
  const anyInstalling = rows.some((row) => row.installing);
  useEffect(() => {
    setPollWhileInstalling(anyInstalling);
  }, [anyInstalling]);

  // Unknown until its totals answer: a count of the visible rows would be
  // wrong on every tab but All.
  const totalCount = allTotal;
  const connectedCount =
    connectedTotal !== undefined && builtInPage !== undefined
      ? connectedTotal + (builtInRow ? 1 : 0)
      : undefined;
  const notConnectedCount =
    totalCount !== undefined && connectedCount !== undefined
      ? Math.max(0, totalCount - connectedCount)
      : undefined;
  const readyRows = rows
    .filter((row) => row.connected && filter !== "not-connected")
    .sort(
      (a, b) => readyRank(a) - readyRank(b) || a.name.localeCompare(b.name),
    );
  const connectRows = rows
    .filter((row) => !row.connected && filter !== "connected")
    .sort(
      (a, b) =>
        Number(b.installing) - Number(a.installing) ||
        a.name.localeCompare(b.name),
    );
  // The page's total counts the built-in entry on the Not connected query
  // (shown under Connected instead) and leaves it out of the Connected one.
  const builtInAdjustment = !builtInRow
    ? 0
    : filter === "connected"
      ? 1
      : filter === "not-connected"
        ? -1
        : 0;
  const unlisted = Math.max(
    0,
    (page.data?.pagination.total ?? 0) + builtInAdjustment - rows.length,
  );

  /** The full item an action works on, loaded when the action starts. */
  const withFullItem = async (
    row: { id: string },
    act: (catalog: CatalogItem) => void,
  ) => {
    const catalog = await fetchInternalMcpCatalogItem(queryClient, row.id);
    if (catalog) act(catalog);
  };

  const handleConnect = (row: McpRegistryRow) => {
    if (row.setupNeeds.signIn) {
      installer.triggerInstallByCatalogId(row.id);
    } else {
      void withFullItem(row, onConnect);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <QuickEditViewHeader
        backLabel={agentName}
        onBack={onBack}
        title="Add tools"
      />
      <div className="flex shrink-0 flex-wrap items-center gap-2 px-5 pt-4 pb-2">
        <div className="relative min-w-48 flex-1">
          <Search className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search servers"
            aria-label="Search servers"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            className="pl-9"
            autoFocus
          />
        </div>
        <fieldset
          aria-label="Filter servers"
          className="flex shrink-0 gap-0.5 rounded-lg bg-muted p-0.5"
        >
          {(
            [
              ["all", withCount("All", totalCount)],
              ["connected", withCount("Connected", connectedCount)],
              ["not-connected", withCount("Not connected", notConnectedCount)],
            ] as const
          ).map(([value, label]) => (
            <Button
              key={value}
              variant="ghost"
              size="xs"
              aria-pressed={filter === value}
              onClick={() => setFilter(value)}
              className={cn(
                filter === value &&
                  "bg-background shadow-xs hover:bg-background",
              )}
            >
              {label}
            </Button>
          ))}
        </fieldset>
      </div>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 pt-2 pb-4">
        {isPending ? (
          <div className="space-y-1.5">
            {[0, 1, 2].map((key) => (
              <Skeleton key={key} className="h-[52px] w-full rounded-lg" />
            ))}
          </div>
        ) : readyRows.length === 0 && connectRows.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            No servers match "{search}"
          </p>
        ) : (
          <>
            {readyRows.length > 0 && (
              <ServerGroup title="Ready to add">
                {readyRows.map((row) => {
                  const count = row.catalog.toolCount;
                  const noTools = count === 0;
                  const adding = addAll.addingCatalogId === row.catalog.id;
                  return (
                    <ServerRow
                      key={row.catalog.id}
                      catalog={row.catalog}
                      name={row.name}
                      muted={row.assigned || noTools}
                      meta={
                        noTools
                          ? "Connected, but the server reports no tools"
                          : joinMeta(
                              `${count} ${count === 1 ? "tool" : "tools"}`,
                              row.catalog.description,
                            )
                      }
                      action={
                        row.assigned ? (
                          <span className="flex items-center gap-1 px-2 text-xs font-medium text-emerald-700 dark:text-emerald-400">
                            <Check className="size-3.5" />
                            <span>Added</span>
                          </span>
                        ) : noTools ? (
                          <span className="px-2 text-xs text-muted-foreground">
                            No tools
                          </span>
                        ) : (
                          <>
                            <Button
                              variant="ghost"
                              size="xs"
                              disabled={adding}
                              onClick={() =>
                                void withFullItem(row.catalog, onChooseTools)
                              }
                            >
                              Choose tools
                            </Button>
                            <Button
                              variant="outline"
                              size="xs"
                              disabled={adding}
                              onClick={() =>
                                void withFullItem(row.catalog, (catalog) =>
                                  addAll.run({
                                    catalog,
                                    name: row.name,
                                    onAdded,
                                    onFailed,
                                  }),
                                )
                              }
                            >
                              {adding && <Loader2 className="animate-spin" />}
                              <span>{adding ? "Adding…" : "Add all"}</span>
                            </Button>
                          </>
                        )
                      }
                    />
                  );
                })}
              </ServerGroup>
            )}
            {connectRows.length > 0 && (
              <ServerGroup title="Connect first">
                {connectRows.map((row) => (
                  <ServerRow
                    key={row.catalog.id}
                    catalog={row.catalog}
                    name={row.name}
                    meta={
                      row.installing
                        ? "Connecting · discovering tools"
                        : connectHint(row.catalog)
                    }
                    action={
                      row.installing ? (
                        <span className="flex items-center gap-1.5 px-2 text-xs text-muted-foreground">
                          <Loader2 className="size-3.5 animate-spin" />
                          <span>Installing</span>
                        </span>
                      ) : (
                        <Button
                          size="xs"
                          onClick={() => handleConnect(row.catalog)}
                        >
                          Connect
                        </Button>
                      )
                    }
                  />
                ))}
              </ServerGroup>
            )}
            {unlisted > 0 && (
              <p className="text-center text-xs text-muted-foreground">
                {unlisted} more {unlisted === 1 ? "server" : "servers"} — search
                to find {unlisted === 1 ? "it" : "them"}.
              </p>
            )}
          </>
        )}
      </div>

      <QuickEditFooter>
        <span className="text-xs text-muted-foreground">
          Not listed?{" "}
          <a
            href="/mcp/registry"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-foreground underline-offset-4 hover:underline"
          >
            Add a server to the registry
            <ExternalLink className="size-3" />
          </a>
        </span>
        <span />
      </QuickEditFooter>
    </div>
  );
}

/**
 * Connects a server inside the dialog — the registry's own install form,
 * shown inline — then hands over to {@link InstallingView}. Servers that sign
 * in by redirect never reach here; they use the registry's modal flow.
 */
export function ConnectView({
  catalog,
  agentName,
  installer,
  addWhenConnected,
  onAddWhenConnectedChange,
  onCancel,
  onConnected,
}: {
  catalog: CatalogItem;
  agentName: string;
  installer: McpInstallOrchestrator;
  addWhenConnected: boolean;
  onAddWhenConnectedChange: (value: boolean) => void;
  onCancel: () => void;
  onConnected: () => void;
}) {
  const allCredentials = useMcpServersGroupedByCatalog({
    catalogId: catalog.id,
  });
  const serverCount = allCredentials?.[catalog.id]?.length ?? 0;
  const [attempt, setAttempt] = useState<"idle" | "submitted" | "settled">(
    "idle",
  );
  const startedRef = useRef(false);

  // The orchestrator owns which form a catalog needs and its install calls;
  // selecting the catalog here is what fills the inline form below.
  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    installer.triggerInstallByCatalogId(catalog.id);
  }, [installer, catalog.id]);

  // An install that the API refused toasts its reason and leaves no server;
  // the form stays for another try rather than spinning forever.
  useEffect(() => {
    if (attempt === "idle") return;
    if (serverCount > 0) onConnected();
    else if (attempt === "settled") setAttempt("idle");
  }, [attempt, serverCount, onConnected]);

  const submit = async (install: () => Promise<void>) => {
    setAttempt("submitted");
    try {
      await install();
    } finally {
      setAttempt("settled");
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <QuickEditViewHeader
        backLabel="Add tools"
        onBack={onCancel}
        title={`Connect ${catalog.name}`}
      />
      <Steps
        current={1}
        steps={[`Connect ${catalog.name}`, `Add its tools to ${agentName}`]}
      />
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4">
        {/* Above the form, so it is read before the form's Install button. */}
        <Label className="flex cursor-pointer items-start gap-3 rounded-lg border bg-background p-3 font-normal">
          <Checkbox
            checked={addWhenConnected}
            onCheckedChange={(checked) =>
              onAddWhenConnectedChange(checked === true)
            }
            className="mt-0.5"
          />
          <span className="space-y-0.5">
            <span className="block text-sm font-medium">
              Add all its tools to {agentName} when connected
            </span>
            <span className="block text-xs text-muted-foreground">
              Untick to pick tools yourself once it's connected.
            </span>
          </span>
        </Label>
        {installer.isDialogOpened("local-install") &&
          installer.localServerCatalogItem && (
            <LocalServerInstallDialog
              presentation="inline"
              isOpen
              onClose={onCancel}
              onConfirm={(result) =>
                submit(() => installer.handleLocalServerInstallConfirm(result))
              }
              catalogItem={installer.localServerCatalogItem}
              isInstalling={installer.isInstalling}
            />
          )}
        {installer.isDialogOpened("remote-install") && (
          <RemoteServerInstallDialog
            presentation="inline"
            isOpen
            onClose={onCancel}
            onConfirm={(item, result) =>
              submit(() =>
                installer.handleRemoteServerInstallConfirm(item, result),
              )
            }
            catalogItem={installer.selectedCatalogItem}
            isInstalling={installer.isInstalling}
          />
        )}
        {installer.isDialogOpened("no-auth") && (
          <NoAuthInstallDialog
            presentation="inline"
            isOpen
            onClose={onCancel}
            onInstall={(result) =>
              submit(() => installer.handleNoAuthConfirm(result))
            }
            catalogItem={installer.noAuthCatalogItem}
            isInstalling={installer.isInstalling}
          />
        )}
      </div>
    </div>
  );
}

/**
 * Follows a fresh install until its tools are discovered, then adds them (or
 * opens "Choose tools" when the user opted out of adding all).
 */
export function InstallingView({
  catalog,
  agentId,
  agentName,
  addWhenConnected,
  onBack,
  onChooseTools,
  onAdded,
  onFailed,
}: {
  catalog: CatalogItem;
  agentId: string;
  agentName: string;
  addWhenConnected: boolean;
  onBack: () => void;
  onChooseTools: (catalog: CatalogItem) => void;
  onAdded: (catalogId: string) => void;
  onFailed: (notice: QuickEditNotice) => void;
}) {
  const allCredentials = useMcpServersGroupedByCatalog({
    catalogId: catalog.id,
  });
  const servers = allCredentials?.[catalog.id] ?? [];
  const installing = servers.some((server) =>
    isInstallInProgress(server.localInstallationStatus),
  );
  useMcpServers({ catalogId: catalog.id, hasInstallingServers: installing });
  const failedServer = servers.find(
    (server) => server.localInstallationStatus === "error",
  );
  const ready = servers.length > 0 && !installing && !failedServer;
  const ownServer = servers[0];
  const addAll = useAddAllServerTools({ agentId, agentName });
  const [noTools, setNoTools] = useState(false);
  const handledRef = useRef(false);

  useEffect(() => {
    if (!ready || handledRef.current) return;
    handledRef.current = true;
    if (!addWhenConnected) {
      onChooseTools(catalog);
      return;
    }
    addAll.run({
      catalog,
      name: catalog.name,
      onAdded,
      onFailed,
      onNoTools: () => setNoTools(true),
    });
  }, [
    ready,
    addWhenConnected,
    catalog,
    addAll,
    onAdded,
    onFailed,
    onChooseTools,
  ]);

  const connectionText =
    ownServer?.scope === "org"
      ? "Everyone in the organization can use it."
      : ownServer?.scope === "team"
        ? "Everyone on the team can use it."
        : `Only you can use it. Other people chatting with ${agentName} connect their own.`;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <QuickEditViewHeader
        backLabel="Add tools"
        onBack={onBack}
        title={`Connect ${catalog.name}`}
      />
      <Steps
        current={2}
        steps={[`Connect ${catalog.name}`, `Add its tools to ${agentName}`]}
      />
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-5">
        <div className="flex items-center gap-3">
          <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-muted">
            <McpCatalogIcon
              icon={catalog.icon}
              catalogId={catalog.id}
              size={22}
            />
          </div>
          <div>
            <p className="text-sm font-semibold">Setting up {catalog.name}</p>
            <p className="text-xs text-muted-foreground">
              Usually under a minute
            </p>
          </div>
        </div>

        {failedServer ? (
          <InlineNotice variant="error" role="alert">
            <AlertTriangle />
            <InlineNoticeBody>
              <span className="font-medium">{catalog.name} didn't start</span>
              <InlineNoticeText>
                {failedServer.localInstallationError ??
                  "The server failed while starting. Check its logs in the MCP registry."}
              </InlineNoticeText>
            </InlineNoticeBody>
          </InlineNotice>
        ) : noTools ? (
          <InlineNotice variant="neutral" role="status">
            <AlertTriangle />
            <InlineNoticeBody>
              <span className="font-medium">
                {catalog.name} is connected, but reports no tools
              </span>
              <InlineNoticeText>
                There is nothing to add to {agentName}.
              </InlineNoticeText>
            </InlineNoticeBody>
          </InlineNotice>
        ) : null}

        <ol
          aria-live="polite"
          className="divide-y rounded-lg border bg-background px-4"
        >
          <ProgressStep
            state="done"
            title="Connection saved"
            description={connectionText}
          />
          <ProgressStep
            state={failedServer ? "failed" : ready ? "done" : "active"}
            title="Starting the server and discovering tools"
            description="The server lists what it can do."
          />
          <ProgressStep
            state={
              ready && addWhenConnected && !noTools
                ? "active"
                : addWhenConnected
                  ? "pending"
                  : "skipped"
            }
            title={
              addWhenConnected
                ? `Add all tools to ${agentName}`
                : "Choose which tools to add"
            }
            description="Each person's own connection is used when the tools run."
          />
        </ol>

        <p className="text-xs text-muted-foreground">
          If you close this, {catalog.name} stays connected and you can add its
          tools from the list later.
        </p>
      </div>
      {(failedServer || noTools) && (
        <QuickEditFooter>
          <span />
          <Button variant="outline" onClick={onBack}>
            Back to Add tools
          </Button>
        </QuickEditFooter>
      )}
    </div>
  );
}

// ============================================================================
// Internal
// ============================================================================

/** Adds every tool of a server, tracking which row is busy. */
function useAddAllServerTools({
  agentId,
  agentName,
}: {
  agentId: string;
  agentName: string;
}) {
  const serverTools = useUpdateAgentServerTools();
  const [addingCatalogId, setAddingCatalogId] = useState<string | null>(null);

  return useMemo(
    () => ({
      addingCatalogId,
      run: async ({
        catalog,
        name,
        onAdded,
        onFailed,
        onNoTools,
      }: {
        catalog: CatalogItem;
        name: string;
        onAdded: (catalogId: string) => void;
        onFailed: (notice: QuickEditNotice) => void;
        onNoTools?: () => void;
      }) => {
        setAddingCatalogId(catalog.id);
        const retry = () =>
          void runAdd({
            catalog,
            name,
            agentId,
            agentName,
            serverTools,
            onAdded,
            onFailed,
            onNoTools,
          });
        await runAdd({
          catalog,
          name,
          agentId,
          agentName,
          serverTools,
          onAdded,
          onFailed: (notice) => onFailed({ ...notice, onRetry: retry }),
          onNoTools,
        });
        setAddingCatalogId(null);
      },
    }),
    [addingCatalogId, agentId, agentName, serverTools],
  );
}

async function runAdd({
  catalog,
  name,
  agentId,
  agentName,
  serverTools,
  onAdded,
  onFailed,
  onNoTools,
}: {
  catalog: CatalogItem;
  name: string;
  agentId: string;
  agentName: string;
  serverTools: ReturnType<typeof useUpdateAgentServerTools>;
  onAdded: (catalogId: string) => void;
  onFailed: (notice: QuickEditNotice) => void;
  onNoTools?: () => void;
}) {
  const tools = await fetchCatalogTools(catalog.id);
  if (tools.length === 0) {
    onNoTools?.();
    return;
  }
  try {
    await serverTools.mutateAsync({
      agentId,
      add: tools.map((tool) => tool.id),
      remove: [],
      builtIn: catalog.serverType === "builtin",
      undoToast: { agentName, serverName: name },
    });
    onAdded(catalog.id);
  } catch (error) {
    const added =
      error instanceof ServerToolsUpdateError
        ? `${error.addedCount} of ${error.requestedAddCount} tools were added. `
        : "";
    onFailed({
      title: `Couldn't add tools from ${name}`,
      message: `${added}The server said: "${error instanceof Error ? error.message : String(error)}"`,
    });
  }
}

function readyRank(row: { assigned: boolean; catalog: McpRegistryRow }) {
  if (row.assigned) return 1;
  if (row.catalog.toolCount === 0) return 2;
  return 0;
}

function connectHint(catalog: McpRegistryRow) {
  if (catalog.setupNeeds.signIn) return "Sign in with your account";
  const settings = catalog.setupNeeds.settings;
  if (settings > 0) {
    return `Needs ${settings} ${settings === 1 ? "setting" : "settings"} to connect`;
  }
  return joinMeta("No setup needed", catalog.description);
}

function joinMeta(...parts: (string | null | undefined)[]) {
  return parts.filter(Boolean).join(" · ");
}

function ServerGroup({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="space-y-1.5">
      <h3 className="text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">
        {title}
      </h3>
      <ul className="space-y-1.5">{children}</ul>
    </section>
  );
}

function ServerRow({
  catalog,
  name,
  meta,
  action,
  muted = false,
}: {
  catalog: Pick<McpRegistryRow, "id" | "icon" | "iconUrl">;
  name: string;
  meta: string;
  action: ReactNode;
  muted?: boolean;
}) {
  return (
    <li
      className={cn(
        "flex items-center gap-3 rounded-lg border py-2 pr-2 pl-3",
        muted ? "bg-muted/30" : "bg-background",
      )}
    >
      <div className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted">
        <McpCatalogIcon
          icon={catalog.iconUrl ?? catalog.icon}
          catalogId={catalog.id}
          size={20}
        />
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">{name}</div>
        <div className="truncate text-xs text-muted-foreground">{meta}</div>
      </div>
      <div className="flex shrink-0 items-center gap-1">{action}</div>
    </li>
  );
}

function Steps({ current, steps }: { current: 1 | 2; steps: string[] }) {
  return (
    <ol className="flex shrink-0 items-center gap-3 border-b px-5 py-3">
      {steps.map((label, index) => {
        const step = index + 1;
        const done = step < current;
        const active = step === current;
        return (
          <li key={label} className="flex min-w-0 items-center gap-3">
            {index > 0 && (
              <span
                aria-hidden="true"
                className={cn(
                  "h-px w-8 shrink-0",
                  done || active ? "bg-emerald-600" : "bg-border",
                )}
              />
            )}
            <span
              className={cn(
                "flex min-w-0 items-center gap-2 text-xs font-medium",
                active ? "text-foreground" : "text-muted-foreground",
              )}
              aria-current={active ? "step" : undefined}
            >
              <span
                className={cn(
                  "flex size-5 shrink-0 items-center justify-center rounded-full border text-[11px]",
                  done && "border-emerald-600 bg-emerald-600 text-white",
                  active && "border-primary bg-primary text-primary-foreground",
                )}
              >
                {done ? <Check className="size-3" /> : <span>{step}</span>}
              </span>
              <span className="truncate">{label}</span>
            </span>
          </li>
        );
      })}
    </ol>
  );
}

function ProgressStep({
  state,
  title,
  description,
}: {
  state: "done" | "active" | "pending" | "failed" | "skipped";
  title: string;
  description: string;
}) {
  return (
    <li className="flex items-start gap-3 py-3">
      <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center">
        {state === "done" ? (
          <Check className="size-4 text-emerald-600" aria-label="Done" />
        ) : state === "active" ? (
          <Loader2 className="size-4 animate-spin" aria-label="In progress" />
        ) : state === "failed" ? (
          <AlertTriangle
            className="size-4 text-destructive"
            aria-label="Failed"
          />
        ) : (
          <Circle
            className="size-3.5 text-muted-foreground"
            aria-label="Not started"
          />
        )}
      </span>
      <div className="min-w-0 flex-1">
        <p
          className={cn(
            "text-sm font-medium",
            (state === "pending" || state === "skipped") &&
              "text-muted-foreground",
          )}
        >
          {title}
        </p>
        <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>
        {state === "active" && (
          <div className="mt-2.5 h-1.5 overflow-hidden rounded-full bg-muted">
            <div className="h-full w-1/2 animate-pulse rounded-full bg-primary" />
          </div>
        )}
      </div>
    </li>
  );
}

/** Rows the list shows at a time; a search narrows on the server. */
const ADD_TOOLS_PAGE_SIZE = 100;

function withCount(label: string, count: number | undefined) {
  return count === undefined ? label : `${label} ${count}`;
}
