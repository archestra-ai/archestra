"use client";

import { RESOURCE_ACCESS_RELATIONS } from "@archestra/shared";
import type { ColumnDef, SortingState } from "@tanstack/react-table";
import {
  ArchiveRestore,
  Braces,
  ChevronDown,
  ChevronUp,
  GitBranch,
  PackagePlus,
  Pencil,
  Plus,
  Puzzle,
  Trash2,
} from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import { ErrorBoundary } from "@/app/_parts/error-boundary";
import { OsLogos } from "@/app/connection/os-logos";
import { BulkResourceAccessDialog } from "@/components/bulk-resource-access-dialog";
import { EmptyState } from "@/components/empty-state";
import { EntityLabelFilter } from "@/components/entity-label-filter";
import {
  CollectionFilters,
  FilterBar,
  filterControlClass,
  filterSearchClass,
} from "@/components/filter-bar";
import { LabelTags } from "@/components/label-tags";
import { PageLayout } from "@/components/page-layout";
import {
  PERMANENT_DELETE_LABEL,
  PermanentDeleteDialog,
  permanentDeleteRowAction,
} from "@/components/permanent-delete";
import { QueryLoadError } from "@/components/query-load-error";
import { RepositoryOwnerIcon } from "@/components/repository-owner-icon";
import {
  RESOURCE_ACCESS_FILTER_PARAMS,
  ResourceAccessFilter,
} from "@/components/resource-access-filter";
import { RESOURCE_ACCESS_PARAM } from "@/components/resource-access-params";
import { ResourceListActions } from "@/components/resource-list-actions";
import {
  ActiveFilterBadges,
  ResourceDeletedStatusFilter,
  useScopeFilterParams,
} from "@/components/resource-scope-filter";
import { SearchInput } from "@/components/search-input";
import {
  TableCard,
  TableCardList,
  TableCardView,
  TableCardViewContent,
  TableCardViewToggle,
} from "@/components/table-card-view";
import type { TableRowAction } from "@/components/table-row-actions";
import { TableRowActions } from "@/components/table-row-actions";
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
  useHasPermissions,
  useScopedCapabilities,
} from "@/lib/auth/auth.query";
import { holdsItemGrant } from "@/lib/auth/auth.utils";
import { ACTION_LABEL } from "@/lib/design/resource-lexicon";
import {
  usePluginLabelKeys,
  usePluginLabelValues,
} from "@/lib/entity-labels.query";
import { useBulkCardSelection } from "@/lib/hooks/use-bulk-card-selection";
import { useBulkSelection } from "@/lib/hooks/use-bulk-selection";
import { useIsGlobalAdmin } from "@/lib/organization.query";
import {
  type PluginListItem,
  usePermanentlyDeletePlugins,
  usePlugins,
  useRestorePlugins,
} from "@/lib/plugins/plugin.query";
import { repositoryLabel } from "@/lib/skills/skill-source";
import { formatRelativeTimeFromNow } from "@/lib/utils/date-time";
import { DeletePluginsDialog } from "./_parts/delete-plugins-dialog";
import {
  getPluginActionModel,
  pluginAction,
  pluginActionHref,
} from "./_parts/plugin-actions-model";
import { PluginClientIcon } from "./_parts/plugin-client-icon";
import { PluginInstallDialog } from "./_parts/plugin-install-dialog";
import {
  CLIENT_LABELS,
  pluginDetailHref,
  resolvePluginInstallSelection,
} from "./_parts/plugin-page-config";
import {
  PluginSourceIcon,
  pluginRepository,
} from "./_parts/plugin-source-icon";
import { PluginSourceLabel } from "./_parts/plugin-source-info";

const PLUGINS_DESCRIPTION =
  "Extensions for local agents like Claude Code or Codex.";

export default function PluginsPage() {
  return (
    <div className="h-full w-full">
      <ErrorBoundary>
        <PluginsList />
      </ErrorBoundary>
    </div>
  );
}

function PluginsList() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  // Bulk actions are offered only when every selected plugin allows them.
  const { data: pluginGrants } = useScopedCapabilities();

  const search = (searchParams.get("search") ?? "").trim().toLowerCase();
  const client = searchParams.get("client") ?? "all";
  const platform = searchParams.get("platform") ?? "all";
  const source = searchParams.get("source") ?? "all";
  const sourceRepo = searchParams.get("sourceRepo") ?? "";
  const scopeFilter = useScopeFilterParams();
  // Label filtering is server-side, so the value rides the list query rather
  // than narrowing the already-fetched array below.
  const labelsFilter = searchParams.get("labels") || undefined;
  // The deleted view lists the trash. It is for a reader who manages every
  // plugin (`plugin:update` at `*`, the grant the API asks for); for anyone
  // else `?status=deleted` shows the live list, which is what they can read.
  const isDeletedRequested = searchParams.get("status") === "deleted";
  const manageAll = useHasPermissions({ plugin: ["update"] }, "*");
  const isDeletedView = isDeletedRequested && manageAll.data === true;
  // Neither list is asked for until it is known which one this reader gets.
  const isDeletedViewUndecided = isDeletedRequested && manageAll.isPending;

  const {
    data: plugins,
    isPending,
    isFetching,
    isLoadingError,
    error: pluginsError,
    refetch,
  } = usePlugins(!isDeletedViewUndecided, {
    labels: labelsFilter,
    // The trash is every deleted plugin, for the reader who manages every
    // plugin: the live list's "Mine · Shared with me" would leave out the
    // ones other people deleted, which are the ones an admin comes here for.
    ...(isDeletedView
      ? {}
      : {
          access: scopeFilter.access,
          sharedWith: scopeFilter.sharedWith,
          owner: scopeFilter.owner,
        }),
    status: isDeletedView ? "deleted" : undefined,
  });

  const setFilter = useCallback(
    (name: string, value: string) => {
      const params = new URLSearchParams(searchParams.toString());
      if (value === "all" || value === "") params.delete(name);
      else params.set(name, value);
      // A narrowed list starts from its first page.
      params.delete("page");
      router.push(`${pathname}?${params.toString()}`, { scroll: false });
    },
    [pathname, router, searchParams],
  );

  const [sorting, setSorting] = useState<SortingState>([
    { id: "displayName", desc: false },
  ]);
  const nameDescending = sorting[0]?.desc ?? false;

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
            if (pluginRepository(plugin) !== sourceRepo) return false;
          }
          return true;
        })
        // One order for the table and the cards: the Plugin header sets it.
        .sort(
          (left, right) =>
            left.displayName.localeCompare(right.displayName) *
            (nameDescending ? -1 : 1),
        ),
    [plugins, search, client, platform, source, sourceRepo, nameDescending],
  );

  // Only imported plugins have a repository, so the filter stays hidden until
  // at least one plugin is imported.
  // A repository named in the URL is listed too, even when no plugin comes
  // from it: the filter is narrowing the list, so its control has to show it.
  const sourceRepos = useMemo(
    () =>
      Array.from(
        new Set(
          [...(plugins ?? []).map(pluginRepository), sourceRepo].filter(
            (repo): repo is string => !!repo,
          ),
        ),
      ).sort(),
    [plugins, sourceRepo],
  );

  const hasActiveFilters = Boolean(
    search ||
      client !== "all" ||
      platform !== "all" ||
      source !== "all" ||
      sourceRepo ||
      searchParams.has("state") ||
      scopeFilter.hasActiveScopeFilters ||
      Boolean(labelsFilter) ||
      // An empty trash is not "no plugins yet".
      isDeletedRequested,
  );

  const clearFilters = useCallback(() => {
    const params = new URLSearchParams(searchParams.toString());
    for (const key of [
      "search",
      "client",
      "platform",
      "source",
      "state",
      "status",
      "sourceRepo",
      "page",
      "scope",
      "teamIds",
      "authorIds",
      "excludeAuthorIds",
      ...RESOURCE_ACCESS_FILTER_PARAMS,
      "labels",
    ]) {
      params.delete(key);
    }
    router.push(`${pathname}?${params.toString()}`, { scroll: false });
  }, [pathname, router, searchParams]);

  const [deletingPlugin, setDeletingPlugin] = useState<PluginListItem | null>(
    null,
  );
  const [bulkVisibilityOpen, setBulkVisibilityOpen] = useState(false);
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);
  const [bulkInstallOpen, setBulkInstallOpen] = useState(false);
  const { rangeSelection, ...bulkSelection } = useBulkSelection({
    rows: filteredPlugins,
    getId: (plugin) => plugin.id,
    filterSignature: JSON.stringify({
      search,
      client,
      platform,
      source,
      sourceRepo,
      labels: labelsFilter,
      deleted: isDeletedView,
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
  const allSelectedAllow = (action: "use" | "manage-permissions" | "delete") =>
    bulkSelection.selected.length > 0 &&
    bulkSelection.selected.every((plugin) =>
      holdsItemGrant({
        grants: pluginGrants,
        resource: "plugin",
        action,
        id: plugin.id,
      }),
    );
  const canInstallSelected = allSelectedAllow("use");
  const canShareSelected = allSelectedAllow("manage-permissions");
  const canDeleteSelected = allSelectedAllow("delete");
  const [installingPlugin, setInstallingPlugin] =
    useState<PluginListItem | null>(null);

  const admin = useIsGlobalAdmin();
  const restorePlugins = useRestorePlugins();
  // One plugin from its row, or the ticked ones from the bulk bar: the same
  // question either way.
  const [permanentlyDeleting, setPermanentlyDeleting] = useState<{
    plugins: readonly PluginListItem[];
    fromSelection: boolean;
  } | null>(null);
  const named = (list: readonly PluginListItem[]) =>
    list.map((plugin) => ({ id: plugin.id, name: plugin.displayName }));
  // No confirmation: nothing is lost by a restore.
  const restoreSelected = async () => {
    const result = await restorePlugins
      .mutateAsync(named(bulkSelection.selected))
      .catch(() => null);
    if (result && result.succeeded.length > 0) bulkSelection.clearSelection();
  };

  const renderPluginActions = (plugin: PluginListItem) => {
    if (isDeletedView) {
      // A deleted plugin can come back or go for good; it has no page to
      // open and nothing to install.
      const deleteGrant = {
        permissions: {},
        disabled: !holdsItemGrant({
          grants: pluginGrants,
          resource: "plugin",
          action: "delete",
          id: plugin.id,
        }),
        disabledTooltip: "You do not have permission to restore this plugin",
      };
      return (
        <TableRowActions
          itemName={plugin.displayName}
          actions={[
            {
              icon: <ArchiveRestore className="h-4 w-4" />,
              label: ACTION_LABEL.restore,
              ...deleteGrant,
              onClick: () => restorePlugins.mutate(named([plugin])),
            },
            permanentDeleteRowAction({
              admin,
              onClick: () =>
                setPermanentlyDeleting({
                  plugins: [plugin],
                  fromSelection: false,
                }),
            }),
          ]}
        />
      );
    }
    const actionModel = getPluginActionModel({ pluginId: plugin.id });
    const installAction = pluginAction(actionModel, "install");
    const editAction = pluginAction(actionModel, "edit");
    const deleteAction = pluginAction(actionModel, "delete");
    const actions: TableRowAction[] = [
      {
        icon: <PackagePlus className="h-4 w-4" />,
        label: installAction.label,
        permissions: installAction.permissions,
        permissionScope: installAction.permissionScope,
        onClick: () => setInstallingPlugin(plugin),
      },
      {
        icon: <Pencil className="h-4 w-4" />,
        label: editAction.label,
        permissions: editAction.permissions,
        permissionScope: editAction.permissionScope,
        href: pluginActionHref(editAction),
      },
      // Inline, not behind a menu: a menu with one item is an extra click.
      {
        icon: <Trash2 className="h-4 w-4" />,
        label: deleteAction.label,
        variant: "destructive",
        permissions: deleteAction.permissions,
        permissionScope: deleteAction.permissionScope,
        onClick: () => setDeletingPlugin(plugin),
      },
    ];
    return <TableRowActions actions={actions} itemName={plugin.displayName} />;
  };

  const columns: ColumnDef<PluginListItem>[] = [
    {
      id: "displayName",
      accessorKey: "displayName",
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
      size: 320,
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
                <LabelTags labels={plugin.labels ?? []} />
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
      id: "details",
      enableSorting: false,
      size: 380,
      header: "Details",
      cell: ({ row }) => {
        const plugin = row.original;
        return (
          <div className="min-w-0 space-y-1.5 text-sm">
            <div className="flex min-w-0 items-center gap-2">
              {clientFilterIcon(plugin.clientType)}
              <span className="truncate text-muted-foreground">
                {CLIENT_LABELS[plugin.clientType] ?? plugin.clientType}
              </span>
              <PluginPlatformMarks platforms={plugin.supportedPlatforms} />
            </div>
            {/* Only an imported plugin has a source to name. */}
            <PluginSourceLabel plugin={plugin} />
          </div>
        );
      },
    },

    {
      id: "actions",
      enableSorting: false,
      size: 130,
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

  const listIsEmpty =
    !isFetching && (plugins?.length ?? 0) === 0 && !hasActiveFilters;
  // The list opens on "Mine · Shared with me", so an empty list is not yet
  // "no plugins": the question is asked again without that filter. Only when
  // the viewer can see no plugin at all is there nothing to list.
  const everyPlugin = usePlugins(listIsEmpty);
  const isCheckingForAnyPlugin =
    listIsEmpty && everyPlugin.isPending && everyPlugin.isFetching;
  const hasNoPlugins = listIsEmpty && everyPlugin.data?.length === 0;
  // Plugins the viewer reaches only through admin access: nobody shared them
  // with the viewer, so the default view leaves them out. An empty list then
  // says they exist and offers them, where it used to say "No plugins yet"
  // beside a Connect page that counted them.
  const adminOnlyCount = listIsEmpty ? (everyPlugin.data?.length ?? 0) : 0;
  const showAdminAccess = () => {
    const params = new URLSearchParams(searchParams.toString());
    params.set(RESOURCE_ACCESS_PARAM, RESOURCE_ACCESS_RELATIONS.join(","));
    params.delete("page");
    router.push(`${pathname}?${params.toString()}`, { scroll: false });
  };
  const emptyList =
    adminOnlyCount > 0
      ? {
          emptyMessage: "No plugins are yours or shared with you.",
          emptyDescription:
            adminOnlyCount === 1
              ? "1 plugin is visible to you with Admin access."
              : `${adminOnlyCount} plugins are visible to you with Admin access.`,
          emptyAction: (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={showAdminAccess}
            >
              Show with Admin access
            </Button>
          ),
        }
      : { emptyMessage: "No plugins yet." };
  const createPermission = useHasPermissions({ plugin: ["create"] });
  // Undefined while the permissions are still loading: nobody is sent on, and
  // nobody is told they cannot add a plugin, before that is known.
  const canCreate = createPermission.isPending
    ? undefined
    : createPermission.data;
  // With no plugins there is no list to show, so the page to add the first
  // one opens in its place; it explains plugins while there are none. Replaced,
  // not pushed, so Back does not land here and bounce forward again.
  const opensAddPage = hasNoPlugins && canCreate === true;
  useEffect(() => {
    if (opensAddPage) router.replace("/plugins/new");
  }, [opensAddPage, router]);

  if (isLoadingError) {
    return (
      <PageLayout title="Plugins" description={PLUGINS_DESCRIPTION}>
        <QueryLoadError
          title="Couldn't load your plugins"
          error={pluginsError}
          onRetry={() => refetch()}
        />
      </PageLayout>
    );
  }

  /**
   * Nothing has come back yet, so the page cannot tell whether it is about to
   * show a list or an empty state. Rendering the list branch meanwhile puts
   * the filter bar and the table on screen and then replaces them with the
   * empty state — see the same guard on the skills page, where that swap
   * measured ~250ms.
   *
   * `isPending` is paired with `isFetching` so a disabled query, which stays
   * pending indefinitely, cannot hold this true.
   *
   * While it is not yet known whether this reader gets the Deleted view, no
   * list is asked for at all. A table drawn over that gap would be empty,
   * and an empty table sends the page in the URL back to one.
   */
  const isInitialPluginsLoad =
    isDeletedViewUndecided || (isPending && isFetching);

  return (
    <>
      <PageLayout
        title="Plugins"
        description={PLUGINS_DESCRIPTION}
        // The header stays the same while loading, empty or listing, so the
        // first plugin doesn't shift it.
        actionButton={
          <div className="flex items-center gap-2">
            {!hasNoPlugins && <AddPluginButton />}
            <ResourceListActions resource="plugin" />
          </div>
        }
      >
        <TableCardView storageKey="archestra-plugins-view" defaultMode="table">
          {isInitialPluginsLoad ||
          isCheckingForAnyPlugin ||
          // On its way to the page that adds the first plugin, or still
          // learning whether the viewer may add one.
          (hasNoPlugins && canCreate !== false) ? null : hasNoPlugins ? (
            // Someone who cannot add a plugin is told who can.
            <EmptyState
              icon={Puzzle}
              title="No plugins yet"
              description="Your admins haven't shared a plugin yet."
            />
          ) : (
            <>
              <CollectionFilters>
                <FilterBar
                  leading
                  onClearFilters={hasActiveFilters ? clearFilters : undefined}
                  moreFilters={[
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
                              "Git repository",
                              <GitBranch key="github" className="size-4" />,
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
                                    .sort((left, right) =>
                                      left.localeCompare(right),
                                    )
                                    .map(
                                      (repo) =>
                                        [
                                          repo,
                                          repositoryLabel(repo),
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
                  // The trash is a table: a deleted plugin has no card to
                  // open.
                  actions={isDeletedView ? undefined : <TableCardViewToggle />}
                  search={
                    <SearchInput
                      paramName="search"
                      className={filterSearchClass}
                    />
                  }
                >
                  {!isDeletedView && (
                    <ResourceAccessFilter resource="plugin" noun="plugins" />
                  )}
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
                      [
                        "claude-desktop",
                        "Claude Desktop",
                        clientFilterIcon("claude-desktop"),
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
                  {/* The grant the API asks of `status=deleted`, so the
                      filter is offered only to a reader the deleted list
                      will answer. */}
                  <ResourceDeletedStatusFilter
                    deletePermission={{ plugin: ["update"] }}
                    deletePermissionScope="*"
                  />
                  <EntityLabelFilter
                    useLabelKeys={usePluginLabelKeys}
                    useLabelValues={usePluginLabelValues}
                    className={filterControlClass({
                      active: Boolean(labelsFilter),
                    })}
                  />
                </FilterBar>
                <ActiveFilterBadges />
              </CollectionFilters>

              <BulkActions
                count={bulkSelection.selected.length}
                noun="plugin"
                onClear={bulkSelection.clearSelection}
                selectAllMatching={bulkSelection.selectAllMatching}
              >
                {isDeletedView ? (
                  <>
                    <PermissionButton
                      permissions={{}}
                      size="sm"
                      disabled={!canDeleteSelected || restorePlugins.isPending}
                      tooltip={
                        canDeleteSelected
                          ? undefined
                          : "You do not have permission to restore every selected plugin"
                      }
                      onClick={restoreSelected}
                    >
                      <ArchiveRestore className="h-4 w-4" />
                      <span>
                        {restorePlugins.isPending
                          ? "Restoring..."
                          : ACTION_LABEL.restore}
                      </span>
                    </PermissionButton>
                    {/* A role, not a permission: offered only to the admins
                        who can do it. */}
                    {admin.isGlobalAdmin && (
                      <Button
                        type="button"
                        variant="destructive"
                        size="sm"
                        onClick={() =>
                          setPermanentlyDeleting({
                            plugins: bulkSelection.selected,
                            fromSelection: true,
                          })
                        }
                      >
                        <Trash2 className="h-4 w-4" />
                        <span>{PERMANENT_DELETE_LABEL}</span>
                      </Button>
                    )}
                  </>
                ) : (
                  <>
                    <PermissionButton
                      permissions={{}}
                      variant="outline"
                      size="sm"
                      disabled={!canInstallSelected || !!bulkInstall.error}
                      tooltip={
                        !canInstallSelected
                          ? "You do not have permission to install every selected plugin"
                          : (bulkInstall.error ?? undefined)
                      }
                      onClick={() => setBulkInstallOpen(true)}
                    >
                      <PackagePlus className="h-4 w-4" />
                      <span>Install</span>
                    </PermissionButton>
                    <PermissionButton
                      permissions={{}}
                      variant="outline"
                      size="sm"
                      disabled={!canShareSelected}
                      tooltip={
                        canShareSelected
                          ? undefined
                          : "You do not have permission to manage access to every selected plugin"
                      }
                      onClick={() => setBulkVisibilityOpen(true)}
                    >
                      <Pencil className="h-4 w-4" />
                      <span>Add access</span>
                    </PermissionButton>
                    <PermissionButton
                      permissions={{}}
                      variant="destructive"
                      size="sm"
                      disabled={!canDeleteSelected}
                      tooltip={
                        canDeleteSelected
                          ? undefined
                          : "You do not have permission to delete every selected plugin"
                      }
                      onClick={() => setBulkDeleteOpen(true)}
                    >
                      <Trash2 className="h-4 w-4" />
                      <span>Delete</span>
                    </PermissionButton>
                  </>
                )}
              </BulkActions>

              <TableCardViewContent
                forceTable={isDeletedView}
                cards={
                  <TableCardList
                    itemCount={filteredPlugins.length}
                    isLoading={isFetching}
                    emptyIcon={Braces}
                    {...emptyList}
                    hasActiveFilters={hasActiveFilters}
                    filteredEmptyMessage="No plugins match the current filters."
                    onClearFilters={clearFilters}
                  >
                    {filteredPlugins.map((plugin) => (
                      <TableCard
                        key={plugin.id}
                        icon={<PluginSourceIcon plugin={plugin} />}
                        title={
                          <span className="flex min-w-0 items-center gap-1.5">
                            <Link
                              href={pluginDetailHref(plugin.id)}
                              className="truncate"
                            >
                              {plugin.displayName}
                            </Link>
                            <LabelTags labels={plugin.labels ?? []} />
                          </span>
                        }
                        description={plugin.description}
                        actions={renderPluginActions(plugin)}
                        onNavigate={() =>
                          router.push(pluginDetailHref(plugin.id))
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
                          <PluginPlatformMarks
                            platforms={plugin.supportedPlatforms}
                          />

                          {/* The repository in words, as the table has it:
                              the mark alone does not say which one. */}
                          <PluginSourceLabel plugin={plugin} />
                        </div>
                      </TableCard>
                    ))}
                  </TableCardList>
                }
                table={
                  <DataTable
                    columns={tableColumns}
                    data={filteredPlugins}
                    urlPagination
                    getRowId={(row) => row.id}
                    emptyIcon={Braces}
                    {...emptyList}
                    hasActiveFilters={hasActiveFilters}
                    filteredEmptyMessage={
                      isDeletedView
                        ? "No deleted plugins found."
                        : "No plugins match the current filters."
                    }
                    onClearFilters={clearFilters}
                    hideSelectedCount
                    sorting={sorting}
                    onSortingChange={setSorting}
                    manualSorting
                    // The list holds only plugins the caller can read. A
                    // deleted plugin has no page to open.
                    onRowClick={
                      isDeletedView
                        ? undefined
                        : (row) => router.push(pluginDetailHref(row.id))
                    }
                    rowSelection={bulkSelection.rowSelection}
                    onRowSelectionChange={bulkSelection.setRowSelection}
                    onPageRowIdsChange={bulkSelection.onPageRowIdsChange}
                    rangeSelection={rangeSelection}
                    isLoading={isFetching}
                    fixedWidthColumnIds={["details", "visibility"]}
                    flexibleColumnIds={["displayName"]}
                  />
                }
              />
            </>
          )}
        </TableCardView>
      </PageLayout>

      {/* A row's delete button and the bulk bar open the same dialog. */}
      {deletingPlugin && (
        <DeletePluginsDialog
          plugins={[deletingPlugin]}
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
        <BulkResourceAccessDialog
          resource="plugin"
          items={bulkSelection.selected.map((plugin) => ({
            id: plugin.id,
            name: plugin.displayName,
          }))}
          open={bulkVisibilityOpen}
          onOpenChange={setBulkVisibilityOpen}
          onApplied={bulkSelection.clearSelection}
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
        <DeletePluginsDialog
          plugins={bulkSelection.selected}
          open={bulkDeleteOpen}
          onOpenChange={setBulkDeleteOpen}
          onDeleted={bulkSelection.clearSelection}
        />
      )}
      {permanentlyDeleting && (
        <PermanentlyDeletePluginsDialog
          plugins={permanentlyDeleting.plugins}
          onClose={() => setPermanentlyDeleting(null)}
          // What was destroyed is no longer there to stay selected.
          onDeleted={
            permanentlyDeleting.fromSelection
              ? bulkSelection.clearSelection
              : undefined
          }
        />
      )}
    </>
  );
}

/**
 * Asks before destroying deleted plugins for good, from a row or from the
 * bulk bar, through the confirmation every trash shares.
 */
function PermanentlyDeletePluginsDialog({
  plugins,
  onClose,
  onDeleted,
}: {
  plugins: readonly PluginListItem[];
  onClose: () => void;
  /** Fires once at least one plugin has been destroyed. */
  onDeleted?: () => void;
}) {
  const permanentlyDelete = usePermanentlyDeletePlugins();
  return (
    <PermanentDeleteDialog
      noun="plugin"
      count={plugins.length}
      open
      onOpenChange={(open) => !open && onClose()}
      isPending={permanentlyDelete.isPending}
      onConfirm={async () => {
        const result = await permanentlyDelete
          .mutateAsync(
            plugins.map((plugin) => ({
              id: plugin.id,
              name: plugin.displayName,
            })),
          )
          .catch(() => null);
        // Nothing destroyed: the toast says why, and the question stays open.
        if (!result || result.succeeded.length === 0) return;
        onDeleted?.();
        onClose();
      }}
    />
  );
}

/** The header's way to a new plugin. */
function AddPluginButton() {
  return (
    <PermissionButton permissions={{ plugin: ["create"] }} size="sm" asChild>
      <Link href="/plugins/new">
        <Plus className="h-4 w-4" />
        Add new plugin
      </Link>
    </PermissionButton>
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

/**
 * The operating systems a plugin installs on, as their marks. One component
 * for the table row and the card, so neither view leaves the platforms out.
 */
function PluginPlatformMarks({
  platforms,
}: {
  platforms: PluginListItem["supportedPlatforms"];
}) {
  const label = [
    platforms.includes("posix") ? "macOS and Linux" : null,
    platforms.includes("windows") ? "Windows" : null,
  ]
    .filter(Boolean)
    .join(", ");
  return (
    <span
      className="flex shrink-0 items-center gap-1.5 text-muted-foreground"
      role="img"
      aria-label={`Supported platforms: ${label}`}
      title={label}
    >
      {platforms.includes("posix") && <OsLogos platform="macos" />}
      {platforms.includes("windows") && <OsLogos platform="windows" />}
    </span>
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
