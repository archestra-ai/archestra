"use client";

import type { ColumnDef, SortingState } from "@tanstack/react-table";
import {
  Braces,
  ChevronDown,
  ChevronUp,
  Github,
  PackagePlus,
  Pencil,
  Plus,
  Trash2,
} from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { type ReactNode, useCallback, useMemo, useState } from "react";
import { ErrorBoundary } from "@/app/_parts/error-boundary";
import { OsLogos } from "@/app/connection/os-logos";
import { BulkVisibilityDialog } from "@/components/bulk-visibility-dialog";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import { EmptyState } from "@/components/empty-state";
import {
  CollectionFilters,
  FilterBar,
  filterControlClass,
  filterSearchClass,
} from "@/components/filter-bar";
import { PageLayout } from "@/components/page-layout";
import { QueryLoadError } from "@/components/query-load-error";
import { RepositoryOwnerIcon } from "@/components/repository-owner-icon";
import {
  ActiveFilterBadges,
  ResourceScopeFilter,
  useScopeFilterParams,
} from "@/components/resource-scope-filter";
import { ResourceVisibilityBadge } from "@/components/resource-visibility-badge";
import { SearchInput } from "@/components/search-input";
import {
  TableCard,
  TableCardList,
  TableCardView,
  TableCardViewContent,
  TableCardViewToggle,
} from "@/components/table-card-view";
import {
  type TableRowAction,
  TableRowActions,
} from "@/components/table-row-actions";
import { Badge } from "@/components/ui/badge";
import { BulkActions } from "@/components/ui/bulk-actions-bar";
import { createSelectColumn } from "@/components/ui/bulk-select-column";
import { Button } from "@/components/ui/button";
import { DataTable } from "@/components/ui/data-table";
import { PermissionButton } from "@/components/ui/permission-button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useHasPermissions, useSession } from "@/lib/auth/auth.query";
import { useFeature } from "@/lib/config/config.query";
import { useBulkCardSelection } from "@/lib/hooks/use-bulk-card-selection";
import { useBulkSelection } from "@/lib/hooks/use-bulk-selection";
import {
  type PluginListItem,
  useBulkDeletePlugins,
  useBulkUpdatePluginVisibility,
  useDeletePlugin,
  usePlugins,
} from "@/lib/plugins/plugin.query";
import { formatRelativeTimeFromNow } from "@/lib/utils/date-time";
import {
  getPluginActionModel,
  pluginAction,
  pluginActionHref,
} from "./_parts/plugin-actions-model";
import { PluginClientIcon } from "./_parts/plugin-client-icon";
import { PluginGithubSyncBadge } from "./_parts/plugin-github-sync-badge";
import { PluginInstallDialog } from "./_parts/plugin-install-dialog";
import {
  ARCHESTRA_PLUGIN_AUTHOR_LABEL,
  CLIENT_LABELS,
  comparePinnedPluginTableOrder,
  comparePluginCatalogOrder,
  comparePluginRepositoryOrder,
  isArchestraPlugin,
  pluginDetailHref,
  resolvePluginInstallSelection,
} from "./_parts/plugin-page-config";
import { PluginSourceIcon } from "./_parts/plugin-source-icon";

const PLUGINS_DESCRIPTION =
  "Plugins ship native hook configurations and companion scripts to connected coding agents, stored verbatim and approved per content hash.";

export default function PluginsPage() {
  return (
    <div className="h-full w-full">
      <ErrorBoundary>
        <PluginsGate />
      </ErrorBoundary>
    </div>
  );
}

function PluginsGate() {
  const enabled = useFeature("plugins");

  // The feature flag arrives with the rest of the config; until it does this
  // page cannot know whether it is a plugins page or a "disabled" notice. It
  // waits without drawing anything rather than stacking a second loader in
  // front of the one the list would show a moment later.
  if (enabled === undefined) {
    return null;
  }

  if (!enabled) {
    return (
      <PageLayout
        title="Plugins"
        description="Plugins are disabled for this deployment."
      >
        <div />
      </PageLayout>
    );
  }

  return <PluginsList />;
}

function PluginsList() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const { data: canViewPluginDetails } = useHasPermissions({
    plugin: ["read", "admin"],
  });

  const search = (searchParams.get("search") ?? "").trim().toLowerCase();
  const client = searchParams.get("client") ?? "all";
  const platform = searchParams.get("platform") ?? "all";
  const source = searchParams.get("source") ?? "all";
  const sourceRepo = searchParams.get("sourceRepo") ?? "";
  const scopeFilter = useScopeFilterParams();

  const { data: plugins, isFetching, isLoadingError, refetch } = usePlugins();
  const { data: session } = useSession();
  const currentUserId = session?.user?.id;

  const setFilter = useCallback(
    (name: string, value: string) => {
      const params = new URLSearchParams(searchParams.toString());
      if (value === "all" || value === "") params.delete(name);
      else params.set(name, value);
      router.push(`${pathname}?${params.toString()}`, { scroll: false });
    },
    [pathname, router, searchParams],
  );

  // The plugin list is small enough to filter and paginate client-side — the
  // API returns every visible plugin in one read.
  const filteredPlugins = useMemo(
    () =>
      (plugins ?? [])
        .filter((plugin) => {
          if (
            search &&
            !`${plugin.displayName} ${plugin.description} ${plugin.pluginSlug} ${plugin.sourceRepo ?? ""} ${plugin.sourceMarketplaceRepo ?? ""}`
              .toLowerCase()
              .includes(search)
          ) {
            return false;
          }
          if (client !== "all" && plugin.clientType !== client) return false;
          if (
            platform !== "all" &&
            !plugin.supportedPlatforms.includes(platform as "posix" | "windows")
          ) {
            return false;
          }
          if (source !== "all") {
            if (source === "github" && plugin.sourceKind !== "github")
              return false;
            if (source === "manual" && plugin.sourceKind !== "manual")
              return false;
          }
          if (sourceRepo) {
            const pluginRepo =
              plugin.sourceMarketplaceRepo ?? plugin.sourceRepo;
            if (pluginRepo !== sourceRepo) return false;
          }
          if (scopeFilter.scope && plugin.scope !== scopeFilter.scope)
            return false;
          const teamIds = scopeFilter.teamIds ?? [];
          const authorIds = scopeFilter.authorIds ?? [];
          const excludeAuthorIds = scopeFilter.excludeAuthorIds ?? [];
          if (
            scopeFilter.scope === "team" &&
            teamIds.length > 0 &&
            !plugin.teams.some((team) => teamIds.includes(team.id))
          ) {
            return false;
          }
          if (
            scopeFilter.scope === "personal" &&
            authorIds.length > 0 &&
            (!plugin.authorId || !authorIds.includes(plugin.authorId))
          ) {
            return false;
          }
          if (
            scopeFilter.scope === "personal" &&
            excludeAuthorIds.length > 0 &&
            plugin.authorId &&
            excludeAuthorIds.includes(plugin.authorId)
          ) {
            return false;
          }
          if (
            scopeFilter.excludeOtherPersonal &&
            plugin.scope === "personal" &&
            plugin.authorId &&
            currentUserId &&
            plugin.authorId !== currentUserId
          ) {
            return false;
          }
          return true;
        })
        .sort(comparePluginCatalogOrder),
    [
      plugins,
      search,
      client,
      platform,
      source,
      sourceRepo,
      scopeFilter,
      currentUserId,
    ],
  );

  // Only imported plugins have a repository, so the filter stays hidden until
  // at least one plugin is imported.
  const sourceRepos = useMemo(
    () =>
      Array.from(
        new Set(
          (plugins ?? [])
            .map((plugin) => plugin.sourceMarketplaceRepo ?? plugin.sourceRepo)
            .filter((repo): repo is string => !!repo),
        ),
      ).sort(),
    [plugins],
  );

  const hasActiveFilters = Boolean(
    search ||
      client !== "all" ||
      platform !== "all" ||
      source !== "all" ||
      sourceRepo ||
      searchParams.has("state") ||
      scopeFilter.hasActiveScopeFilters,
  );

  const clearFilters = useCallback(() => {
    const params = new URLSearchParams(searchParams.toString());
    for (const key of [
      "search",
      "client",
      "platform",
      "source",
      "state",
      "sourceRepo",
      "scope",
      "teamIds",
      "authorIds",
      "excludeAuthorIds",
    ]) {
      params.delete(key);
    }
    router.push(`${pathname}?${params.toString()}`, { scroll: false });
  }, [pathname, router, searchParams]);

  const [sorting, setSorting] = useState<SortingState>([
    { id: "updatedAt", desc: true },
  ]);
  const [deletingPlugin, setDeletingPlugin] = useState<PluginListItem | null>(
    null,
  );
  const [bulkVisibilityOpen, setBulkVisibilityOpen] = useState(false);
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);
  const [bulkInstallOpen, setBulkInstallOpen] = useState(false);
  const bulkVisibility = useBulkUpdatePluginVisibility();
  const bulkDelete = useBulkDeletePlugins();
  const { rangeSelection, ...bulkSelection } = useBulkSelection({
    rows: filteredPlugins,
    getId: (plugin) => plugin.id,
    filterSignature: JSON.stringify({
      search,
      client,
      platform,
      source,
      sourceRepo,
      scopeFilter,
    }),
  });
  const cardSelection = useBulkCardSelection({
    rows: filteredPlugins,
    getRowId: (plugin) => plugin.id,
    rowSelection: bulkSelection.rowSelection,
    setRowSelection: bulkSelection.setRowSelection,
    rangeSelection,
  });
  const bulkInstall = resolvePluginInstallSelection(bulkSelection.selected);
  const [installingPlugin, setInstallingPlugin] =
    useState<PluginListItem | null>(null);

  const renderPluginActions = (plugin: PluginListItem) => {
    const actionModel = getPluginActionModel({ pluginId: plugin.id });
    const installAction = pluginAction(actionModel, "install");
    const editAction = pluginAction(actionModel, "edit");
    const deleteAction = pluginAction(actionModel, "delete");
    const actions: TableRowAction[] = [
      {
        icon: <PackagePlus className="h-4 w-4" />,
        label: installAction.label,
        tooltip: isArchestraPlugin(plugin) ? "Install OpenAPPA" : undefined,
        className: isArchestraPlugin(plugin)
          ? "plugin-featured-action"
          : undefined,
        permissions: installAction.permissions,
        onClick: () => setInstallingPlugin(plugin),
        disabled: !plugin.enabled,
        disabledTooltip: !plugin.enabled
          ? "Disabled plugins cannot be installed"
          : undefined,
      },
      {
        icon: <Pencil className="h-4 w-4" />,
        label: editAction.label,
        permissions: editAction.permissions,
        href: pluginActionHref(editAction),
      },
    ];
    const dropdownActions: TableRowAction[] = [
      {
        icon: <Trash2 className="h-4 w-4" />,
        label: deleteAction.label,
        variant: "destructive",
        permissions: deleteAction.permissions,
        onClick: () => setDeletingPlugin(plugin),
      },
    ];
    return (
      <TableRowActions
        actions={actions}
        dropdownActions={dropdownActions}
        itemName={plugin.displayName}
      />
    );
  };

  const columns: ColumnDef<PluginListItem>[] = [
    {
      id: "displayName",
      accessorKey: "displayName",
      sortingFn: (left, right, columnId) =>
        comparePinnedPluginTableOrder({
          left: left.original,
          right: right.original,
          descending:
            sorting.find((item) => item.id === columnId)?.desc ?? false,
          fallbackResult: left.original.displayName.localeCompare(
            right.original.displayName,
          ),
        }),
      header: ({ column }) => (
        <Button
          variant="ghost"
          className="h-auto !p-0 font-medium hover:bg-transparent"
          onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
        >
          Plugin
          <SortIcon isSorted={column.getIsSorted()} />
        </Button>
      ),
      size: 420,
      cell: ({ row }) => {
        const plugin = row.original;
        return (
          <div className="flex min-w-0 items-center gap-3">
            <PluginSourceIcon plugin={plugin} />
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline gap-2">
                <span className="truncate font-medium">
                  {plugin.displayName}
                </span>
                {isArchestraPlugin(plugin) && (
                  <Badge variant="secondary" className="shrink-0">
                    {ARCHESTRA_PLUGIN_AUTHOR_LABEL}
                  </Badge>
                )}
                {!plugin.enabled && (
                  <Badge variant="outline" className="shrink-0">
                    Disabled
                  </Badge>
                )}
              </div>
              {plugin.description && (
                <div className="truncate text-xs text-muted-foreground">
                  {plugin.description}
                </div>
              )}
            </div>
          </div>
        );
      },
    },
    {
      id: "compatibility",
      size: 190,
      header: "Compatibility",
      cell: ({ row }) => {
        const plugin = row.original;
        const platforms = plugin.supportedPlatforms;
        const platformLabel = [
          platforms.includes("posix") ? "macOS and Linux" : null,
          platforms.includes("windows") ? "Windows" : null,
        ]
          .filter(Boolean)
          .join(", ");
        return (
          <div className="flex min-w-0 items-center gap-2">
            <Badge
              variant="secondary"
              className="min-w-0 gap-1.5 font-normal [&_img]:size-3.5"
            >
              {clientFilterIcon(plugin.clientType)}
              <span className="truncate">
                {CLIENT_LABELS[plugin.clientType] ?? plugin.clientType}
              </span>
            </Badge>
            <span
              className="flex shrink-0 items-center gap-1.5"
              role="img"
              aria-label={`Supported platforms: ${platformLabel}`}
              title={platformLabel}
            >
              {platforms.includes("posix") && <OsLogos platform="macos" />}
              {platforms.includes("windows") && <OsLogos platform="windows" />}
            </span>
          </div>
        );
      },
    },
    {
      id: "visibility",
      size: 130,
      header: "Visibility",
      cell: ({ row }) => (
        <ResourceVisibilityBadge
          scope={row.original.scope}
          teams={row.original.teams}
          users={row.original.users}
          authorId={row.original.authorId}
          authorName={undefined}
          currentUserId={currentUserId}
          showSelfAsMe
        />
      ),
    },
    {
      id: "source",
      size: 250,
      header: "Source",
      cell: ({ row }) => {
        const plugin = row.original;
        const repo = plugin.sourceMarketplaceRepo ?? plugin.sourceRepo;
        if (plugin.sourceKind !== "github") {
          return (
            <span className="inline-flex items-center gap-1.5 text-sm text-muted-foreground">
              <Pencil className="size-3.5" />
              Manual
            </span>
          );
        }
        return (
          <div className="min-w-0 space-y-1">
            <div className="flex items-center gap-1.5">
              <PluginGithubSyncBadge plugin={plugin} />
              {plugin.pendingSourceSha && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Badge
                      variant="outline"
                      className="shrink-0 gap-1 border-amber-500/40 text-amber-600 dark:text-amber-400"
                    >
                      <Github className="h-3 w-3" />
                      Update
                    </Badge>
                  </TooltipTrigger>
                  <TooltipContent className="max-w-xs">
                    A new source commit is waiting for review on the plugin
                    page.
                  </TooltipContent>
                </Tooltip>
              )}
            </div>
            {repo ? (
              <div className="truncate font-mono text-xs text-muted-foreground">
                {repo}
              </div>
            ) : null}
          </div>
        );
      },
    },
    {
      id: "updatedAt",
      accessorKey: "updatedAt",
      sortingFn: (left, right, columnId) =>
        comparePinnedPluginTableOrder({
          left: left.original,
          right: right.original,
          descending:
            sorting.find((item) => item.id === columnId)?.desc ?? false,
          fallbackResult:
            new Date(left.original.updatedAt).getTime() -
            new Date(right.original.updatedAt).getTime(),
        }),
      size: 160,
      header: ({ column }) => (
        <div className="flex justify-end pr-4">
          <Button
            variant="ghost"
            className="h-auto !p-0 font-medium hover:bg-transparent"
            onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
          >
            Activity
            <SortIcon isSorted={column.getIsSorted()} />
          </Button>
        </div>
      ),
      cell: ({ row }) => (
        <div className="space-y-0.5 pr-4 text-right text-sm">
          <div>
            {row.original.fileCount}{" "}
            {row.original.fileCount === 1 ? "file" : "files"}
          </div>
          <div className="text-xs text-muted-foreground">
            Updated {formatRelativeTimeFromNow(row.original.updatedAt)}
          </div>
        </div>
      ),
    },
    {
      id: "actions",
      size: 110,
      header: () => <div className="text-right">Actions</div>,
      cell: ({ row }) => (
        <div className="flex justify-end">
          {renderPluginActions(row.original)}
        </div>
      ),
    },
  ];
  const tableColumns = [
    createSelectColumn<PluginListItem>({
      rowLabel: (plugin) => `Select ${plugin.displayName}`,
    }),
    ...columns,
  ];

  if (isLoadingError) {
    return (
      <PageLayout title="Plugins" description={PLUGINS_DESCRIPTION}>
        <QueryLoadError
          title="Couldn't load your plugins"
          onRetry={() => refetch()}
        />
      </PageLayout>
    );
  }

  const showEmptyState =
    !isFetching && (plugins?.length ?? 0) === 0 && !hasActiveFilters;

  return (
    <>
      <PageLayout
        title="Plugins"
        description={PLUGINS_DESCRIPTION}
        actionButton={
          !showEmptyState && (
            <PermissionButton
              permissions={{ plugin: ["create", "admin"] }}
              asChild
            >
              <Link href="/plugins/new">
                <Plus className="h-4 w-4" />
                Add new plugin
              </Link>
            </PermissionButton>
          )
        }
      >
        <TableCardView storageKey="archestra-plugins-view" defaultMode="table">
          {showEmptyState ? (
            <PluginsEmptyState />
          ) : (
            <>
              <CollectionFilters>
                <FilterBar
                  leading
                  onClearFilters={hasActiveFilters ? clearFilters : undefined}
                  moreFilters={[
                    {
                      key: "visibility",
                      label: "Visibility",
                      active: scopeFilter.hasActiveScopeFilters,
                      control: (
                        <ResourceScopeFilter
                          ownerLabelPlural="plugins"
                          adminPermission={{ plugin: ["admin"] }}
                        />
                      ),
                    },
                    {
                      key: "platform",
                      label: "Platform",
                      active: platform !== "all",
                      control: (
                        <FacetSelect
                          label="Filter by platform"
                          value={platform}
                          onChange={(value) => setFilter("platform", value)}
                          options={[
                            ["all", "All platforms"],
                            [
                              "posix",
                              "macOS / Linux",
                              <OsLogos key="posix" platform="macos" />,
                            ],
                            [
                              "windows",
                              "Windows",
                              <OsLogos key="windows" platform="windows" />,
                            ],
                          ]}
                        />
                      ),
                    },
                    {
                      key: "source",
                      label: "Source",
                      active: source !== "all",
                      control: (
                        <FacetSelect
                          label="Filter by source"
                          value={source}
                          onChange={(value) => setFilter("source", value)}
                          options={[
                            ["all", "All sources"],
                            [
                              "github",
                              "GitHub",
                              <Github key="github" className="size-4" />,
                            ],
                            [
                              "manual",
                              "Manual",
                              <Pencil key="manual" className="size-4" />,
                            ],
                          ]}
                        />
                      ),
                    },
                    ...(sourceRepos.length > 0
                      ? [
                          {
                            key: "repository",
                            label: "Repository",
                            active: !!sourceRepo,
                            control: (
                              <FacetSelect
                                label="Filter by repository"
                                value={sourceRepo || "all"}
                                onChange={(value) =>
                                  setFilter(
                                    "sourceRepo",
                                    value === "all" ? "" : value,
                                  )
                                }
                                options={[
                                  ["all", "All repositories"],
                                  ...[...sourceRepos]
                                    .sort(comparePluginRepositoryOrder)
                                    .map(
                                      (repo) =>
                                        [
                                          repo,
                                          repo,
                                          <RepositoryOwnerIcon
                                            key={repo}
                                            repo={repo}
                                          />,
                                        ] as const,
                                    ),
                                ]}
                              />
                            ),
                          },
                        ]
                      : []),
                  ]}
                  actions={<TableCardViewToggle />}
                >
                  <SearchInput
                    paramName="search"
                    className={filterSearchClass}
                  />
                  <FacetSelect
                    label="Filter by client"
                    value={client}
                    onChange={(value) => setFilter("client", value)}
                    options={[
                      ["all", "All clients"],
                      [
                        "claude-code",
                        "Claude Code",
                        clientFilterIcon("claude-code"),
                      ],
                      ["codex", "Codex", clientFilterIcon("codex")],
                      [
                        "copilot-cli",
                        "Copilot CLI",
                        clientFilterIcon("copilot-cli"),
                      ],
                      ["cursor", "Cursor", clientFilterIcon("cursor")],
                    ]}
                  />
                </FilterBar>
                <ActiveFilterBadges adminPermission={{ plugin: ["admin"] }} />
              </CollectionFilters>

              <BulkActions
                count={bulkSelection.selected.length}
                noun="plugin"
                onClear={bulkSelection.clearSelection}
                busy={bulkVisibility.isPending || bulkDelete.isPending}
                selectAllMatching={bulkSelection.selectAllMatching}
              >
                <PermissionButton
                  permissions={{ plugin: ["read", "admin"] }}
                  variant="outline"
                  size="sm"
                  disabled={!!bulkInstall.error}
                  tooltip={bulkInstall.error ?? undefined}
                  onClick={() => setBulkInstallOpen(true)}
                >
                  <PackagePlus className="h-4 w-4" />
                  <span>Install</span>
                </PermissionButton>
                <PermissionButton
                  permissions={{ plugin: ["update", "admin"] }}
                  variant="outline"
                  size="sm"
                  onClick={() => setBulkVisibilityOpen(true)}
                >
                  <Pencil className="h-4 w-4" />
                  <span>Edit visibility</span>
                </PermissionButton>
                <PermissionButton
                  permissions={{ plugin: ["delete", "admin"] }}
                  variant="destructive"
                  size="sm"
                  onClick={() => setBulkDeleteOpen(true)}
                >
                  <Trash2 className="h-4 w-4" />
                  <span>Delete</span>
                </PermissionButton>
              </BulkActions>

              <TableCardViewContent
                cards={
                  <TableCardList
                    itemCount={filteredPlugins.length}
                    isLoading={isFetching}
                    emptyIcon={Braces}
                    emptyMessage="No plugins yet."
                    hasActiveFilters={hasActiveFilters}
                    filteredEmptyMessage="No plugins match the current filters."
                    onClearFilters={clearFilters}
                  >
                    {filteredPlugins.map((plugin) => (
                      <TableCard
                        key={plugin.id}
                        icon={<PluginSourceIcon plugin={plugin} />}
                        title={
                          canViewPluginDetails ? (
                            <Link href={pluginDetailHref(plugin.id)}>
                              {plugin.displayName}
                            </Link>
                          ) : (
                            <span>{plugin.displayName}</span>
                          )
                        }
                        description={plugin.description}
                        actions={renderPluginActions(plugin)}
                        onNavigate={
                          canViewPluginDetails
                            ? () => router.push(pluginDetailHref(plugin.id))
                            : undefined
                        }
                        {...cardSelection(plugin)}
                        selectionLabel={`Select ${plugin.displayName}`}
                        footer={
                          <div className="flex items-center justify-between gap-3">
                            <span>
                              {plugin.fileCount}{" "}
                              {plugin.fileCount === 1 ? "file" : "files"}
                            </span>
                            <span>
                              Updated{" "}
                              {formatRelativeTimeFromNow(plugin.updatedAt)}
                            </span>
                          </div>
                        }
                      >
                        <div className="flex flex-wrap items-center gap-2">
                          <Badge
                            variant="secondary"
                            className="gap-1.5 font-normal [&_img]:size-3.5"
                          >
                            {clientFilterIcon(plugin.clientType)}
                            <span>
                              {CLIENT_LABELS[plugin.clientType] ??
                                plugin.clientType}
                            </span>
                          </Badge>
                          <ResourceVisibilityBadge
                            scope={plugin.scope}
                            teams={plugin.teams}
                            users={plugin.users}
                            authorId={plugin.authorId}
                            authorName={undefined}
                            currentUserId={currentUserId}
                            showSelfAsMe
                          />
                          {!plugin.enabled ? (
                            <Badge variant="outline">Disabled</Badge>
                          ) : null}
                        </div>
                      </TableCard>
                    ))}
                  </TableCardList>
                }
                table={
                  <DataTable
                    columns={tableColumns}
                    data={filteredPlugins}
                    getRowId={(row) => row.id}
                    emptyIcon={Braces}
                    emptyMessage="No plugins yet."
                    hasActiveFilters={hasActiveFilters}
                    filteredEmptyMessage="No plugins match the current filters."
                    onClearFilters={clearFilters}
                    hideSelectedCount
                    sorting={sorting}
                    onSortingChange={setSorting}
                    onRowClick={
                      canViewPluginDetails
                        ? (row) => router.push(pluginDetailHref(row.id))
                        : undefined
                    }
                    rowSelection={bulkSelection.rowSelection}
                    onRowSelectionChange={bulkSelection.setRowSelection}
                    onPageRowIdsChange={bulkSelection.onPageRowIdsChange}
                    rangeSelection={rangeSelection}
                    isLoading={isFetching}
                    fixedWidthColumnIds={[
                      "compatibility",
                      "visibility",
                      "updatedAt",
                    ]}
                    flexibleColumnIds={["displayName"]}
                  />
                }
              />
            </>
          )}
        </TableCardView>
      </PageLayout>

      {deletingPlugin && (
        <DeletePluginDialog
          plugin={deletingPlugin}
          open={!!deletingPlugin}
          onOpenChange={(open) => !open && setDeletingPlugin(null)}
        />
      )}
      {installingPlugin && (
        <PluginInstallDialog
          plugins={[installingPlugin]}
          open={!!installingPlugin}
          onOpenChange={(open) => !open && setInstallingPlugin(null)}
        />
      )}
      {bulkVisibilityOpen && (
        <BulkVisibilityDialog
          items={bulkSelection.selected}
          noun="plugin"
          open={bulkVisibilityOpen}
          onOpenChange={setBulkVisibilityOpen}
          isPending={bulkVisibility.isPending}
          onApply={async (change) => {
            const result = await bulkVisibility.mutateAsync({
              plugins: bulkSelection.selected.map((plugin) => ({
                id: plugin.id,
                name: plugin.displayName,
              })),
              ...change,
            });
            if (result.succeeded.length > 0) bulkSelection.clearSelection();
            return result.succeeded.length > 0;
          }}
        />
      )}
      {bulkInstallOpen && (
        <PluginInstallDialog
          plugins={bulkSelection.selected}
          open={bulkInstallOpen}
          onOpenChange={setBulkInstallOpen}
        />
      )}
      {bulkDeleteOpen && (
        <DeleteConfirmDialog
          open={bulkDeleteOpen}
          onOpenChange={setBulkDeleteOpen}
          title="Delete plugins"
          description={`Delete ${bulkSelection.selected.length} ${
            bulkSelection.selected.length === 1 ? "plugin" : "plugins"
          }? Their payload files and client delivery will be removed.`}
          isPending={bulkDelete.isPending}
          confirmLabel="Delete plugins"
          onConfirm={async () => {
            const result = await bulkDelete.mutateAsync(
              bulkSelection.selected.map((plugin) => ({
                id: plugin.id,
                name: plugin.displayName,
              })),
            );
            if (result.succeeded.length > 0) {
              bulkSelection.clearSelection();
              setBulkDeleteOpen(false);
            }
          }}
        />
      )}
    </>
  );
}

function PluginsEmptyState() {
  return (
    <EmptyState
      className="min-h-[60vh]"
      icon={Braces}
      title="No plugins yet."
      description="A plugin packages a client's native hooks file and its companion scripts. The platform stores the payload verbatim and delivers it to connected coding agents."
      action={
        <PermissionButton permissions={{ plugin: ["create", "admin"] }} asChild>
          <Link href="/plugins/new">
            <Plus className="mr-2 h-4 w-4" />
            Add your first plugin
          </Link>
        </PermissionButton>
      }
    />
  );
}

function DeletePluginDialog({
  plugin,
  open,
  onOpenChange,
}: {
  plugin: PluginListItem;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const deletePlugin = useDeletePlugin(plugin.id);

  const handleDelete = useCallback(async () => {
    const deleted = await deletePlugin.mutateAsync();
    if (deleted) onOpenChange(false);
  }, [deletePlugin, onOpenChange]);

  return (
    <DeleteConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Delete plugin?"
      description={`Delete "${plugin.displayName}"? It disappears from future marketplace revisions. This does not uninstall code already present on developer machines; remove that plugin locally through the client or startup guard.`}
      isPending={deletePlugin.isPending}
      onConfirm={handleDelete}
    />
  );
}

function FacetSelect({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: Array<readonly [string, string, ReactNode?, string?]>;
}) {
  const selectedOption = options.find(([option]) => option === value);
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger
        size="sm"
        aria-label={label}
        className={filterControlClass({ active: value !== "all" })}
      >
        <SelectValue>
          {selectedOption ? (
            <span className="flex min-w-0 items-center gap-2">
              <span aria-hidden>{selectedOption[2]}</span>
              <span className="truncate">{selectedOption[1]}</span>
            </span>
          ) : null}
        </SelectValue>
      </SelectTrigger>
      <SelectContent
        position="popper"
        side="bottom"
        align="start"
        className="w-auto min-w-[14rem] max-w-[min(22rem,calc(100vw-2rem))]"
      >
        {options.map(([option, text, icon, optionClassName]) => (
          <SelectItem
            key={option}
            value={option}
            icon={icon ? <span aria-hidden>{icon}</span> : undefined}
            className={optionClassName}
          >
            <span className="whitespace-nowrap">{text}</span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function clientFilterIcon(clientType: string): ReactNode {
  return <PluginClientIcon clientType={clientType} />;
}

function SortIcon({ isSorted }: { isSorted: "asc" | "desc" | false }) {
  const upArrow = <ChevronUp className="h-3 w-3" />;
  const downArrow = <ChevronDown className="h-3 w-3" />;
  if (isSorted === "asc") {
    return upArrow;
  }
  if (isSorted === "desc") {
    return downArrow;
  }
  return (
    <div className="text-muted-foreground flex flex-col items-center">
      {upArrow}
      <span className="mt-[-4px]">{downArrow}</span>
    </div>
  );
}
