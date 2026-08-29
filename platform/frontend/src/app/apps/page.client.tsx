"use client";

import type { archestraApiTypes } from "@archestra/shared";
import { AppWindow, Plus, Trash2 } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useMemo, useState } from "react";
import { BulkVisibilityDialog } from "@/components/bulk-visibility-dialog";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import { EmptyState } from "@/components/empty-state";
import {
  CollectionFilters,
  FilterBar,
  filterControlClass,
  filterSearchClass,
} from "@/components/filter-bar";
import {
  LabelFilterBadges,
  LabelKeyRowBase,
  LabelSelect,
  parseLabelsParam,
  serializeLabels,
} from "@/components/label-select";
import { LoadingState, LoadingWrapper } from "@/components/loading";
import { AppSettingsDialog } from "@/components/mcp-app/app-settings-dialog";
import { PageLayout } from "@/components/page-layout";
import { QueryLoadError } from "@/components/query-load-error";
import {
  ResourceScopeFilter,
  useScopeFilterParams,
} from "@/components/resource-scope-filter";
import { SearchInput } from "@/components/search-input";
import {
  TableCardGrid,
  TableCardSelectionScope,
  TableCardView,
  TableCardViewContent,
  TableCardViewToggle,
} from "@/components/table-card-view";
import { BulkActions } from "@/components/ui/bulk-actions-bar";
import { PermissionButton } from "@/components/ui/permission-button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  useAppLabelKeys,
  useAppLabelValues,
  useApps,
  useBulkDeleteApps,
  useBulkUpdateAppVisibility,
} from "@/lib/app.query";
import { sortAppsPinnedFirst } from "@/lib/apps/app-sort";
import { reportBulkOutcome } from "@/lib/bulk-action";
import { useBulkCardSelection } from "@/lib/hooks/use-bulk-card-selection";
import { useBulkSelection } from "@/lib/hooks/use-bulk-selection";
import { useDialogUrlParam } from "@/lib/hooks/use-dialog-url-param";
import { AppCard } from "./_parts/app-card";
import { AppCreateDialog } from "./_parts/app-create-dialog";
import { AppsTable, getAppRowKey } from "./_parts/apps-table";

const PAGE_SIZE = 100;

type AppListItem = archestraApiTypes.GetAppsResponses["200"]["data"][number];
type OwnedApp = Extract<AppListItem, { source: "owned" }>;

export default function AppsPage() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const search = searchParams.get("search") ?? "";
  const kind = searchParams.get("kind") ?? "all";
  // Scope/owner filtering is server-side (mirroring the Projects list) so an
  // app admin's "Personal → Other users" view can reach apps that aren't in the
  // default page. The scope filter component owns these URL params.
  const { scope, authorIds, excludeAuthorIds } = useScopeFilterParams();
  const settingsId = searchParams.get("settings");
  // Label filtering is server-side too: an owned app matches its own labels, an
  // external one its backing MCP server's, so both halves of the list filter.
  const labelsFromUrl = searchParams.get("labels");
  const parsedLabels = parseLabelsParam(labelsFromUrl);
  const { data: labelKeys } = useAppLabelKeys();

  const { data, isPending, isFetching, isLoadingError, refetch } = useApps(
    {
      limit: PAGE_SIZE,
      offset: 0,
      search: search || undefined,
      scope,
      authorIds,
      excludeAuthorIds,
      labels: labelsFromUrl || undefined,
    },
    { toastOnError: false },
  );
  const [createOpen, setCreateOpen] = useState(false);
  // The settings dialog is owned here (one hook instance for the page-level
  // "settings" param); cards only report which app to open it for, and the
  // dialog fetches the full app by id itself. So synthesize the entity from the
  // URL id — the dialog opens instantly and does its own fetching, no
  // page-level fetch needed.
  const {
    entity: settingsApp,
    open: openSettings,
    close: closeSettings,
  } = useDialogUrlParam<{ id: string }>({
    paramName: "settings",
    entityFromUrl: settingsId ? { id: settingsId } : null,
  });

  // Only the "kind" split (owned vs external) is client-side now; scope/owner
  // filtering happens on the server. Pinned-first grouping applies on top,
  // mirroring the Projects page: a "Pinned" section above, everything else below.
  const filtered = useMemo(
    () =>
      sortAppsPinnedFirst(
        (data?.data ?? []).filter((app) => matchesKind(app, kind)),
      ),
    [data, kind],
  );
  const pinnedApps = filtered.filter((app) => app.pinnedAt);
  const unpinnedApps = filtered.filter((app) => !app.pinnedAt);
  // Below "Pinned", owned and external apps are separate sections: apps you
  // authored here vs UIs that came with installed MCP servers.
  const ownedApps = unpinnedApps.filter((app) => app.source === "owned");
  const externalApps = unpinnedApps.filter((app) => app.source === "external");

  const hasActiveFilters =
    Boolean(search) || kind !== "all" || Boolean(labelsFromUrl);

  // Resets the filters this bar owns. Scope/owner is deliberately left alone:
  // it is a view of whose apps you are looking at rather than a narrowing of
  // the list, and clearing it would silently move the user to another view.
  const clearFilters = useCallback(() => {
    const params = new URLSearchParams(searchParams.toString());
    for (const name of ["search", "kind", "labels"]) {
      params.delete(name);
    }
    router.replace(`${pathname}?${params.toString()}`, { scroll: false });
  }, [searchParams, router, pathname]);

  const handleRemoveLabel = useCallback(
    (key: string, value: string) => {
      if (!parsedLabels) return;
      const updated = { ...parsedLabels };
      updated[key] = (updated[key] ?? []).filter((v) => v !== value);
      if (updated[key].length === 0) {
        delete updated[key];
      }
      const params = new URLSearchParams(searchParams.toString());
      const serialized = serializeLabels(updated);
      if (serialized) {
        params.set("labels", serialized);
      } else {
        params.delete("labels");
      }
      router.replace(`${pathname}?${params.toString()}`, { scroll: false });
    },
    [parsedLabels, searchParams, router, pathname],
  );

  const setParam = (name: string, value: string | null) => {
    const params = new URLSearchParams(searchParams.toString());
    if (value) params.set(name, value);
    else params.delete(name);
    router.push(`${pathname}?${params.toString()}`, { scroll: false });
  };

  return (
    <PageLayout
      title="Apps"
      description="Custom, sandboxed UIs over your data and connected MCPs — describe what you want and build it in chat, no engineering required."
      actionButton={
        <PermissionButton
          permissions={{ app: ["create"] }}
          onClick={() => setCreateOpen(true)}
        >
          <Plus className="h-4 w-4" />
          Create
        </PermissionButton>
      }
    >
      <TableCardView storageKey="archestra-apps-view">
        <CollectionFilters>
          <FilterBar leading actions={<TableCardViewToggle />}>
            <SearchInput
              isLoading={isFetching}
              paramName="search"
              placeholder="Search apps"
              className={filterSearchClass}
            />
            <Select
              value={kind}
              onValueChange={(value) =>
                setParam("kind", value === "all" ? null : value)
              }
            >
              <SelectTrigger
                size="sm"
                aria-label="Filter by kind"
                className={filterControlClass({ active: kind !== "all" })}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent position="popper" side="bottom" align="start">
                <SelectItem value="all">All kinds</SelectItem>
                <SelectItem value="owned">Apps</SelectItem>
                <SelectItem value="external">MCP Server Apps</SelectItem>
              </SelectContent>
            </Select>
            <ResourceScopeFilter
              ownerLabelPlural="apps"
              allLabel="All apps"
              adminPermission={{ app: ["admin"] }}
              showTeamSelect={false}
            />
            <LabelSelect
              labelKeys={labelKeys}
              LabelKeyRowComponent={AppLabelKeyRow}
              className={filterControlClass({ active: Boolean(parsedLabels) })}
            />
          </FilterBar>
          {parsedLabels && (
            <LabelFilterBadges onRemoveLabel={handleRemoveLabel} />
          )}
        </CollectionFilters>

        <LoadingWrapper
          isPending={(isPending || isFetching) && filtered.length === 0}
          loadingFallback={<LoadingState variant="page" />}
        >
          {isLoadingError ? (
            <QueryLoadError
              title="Couldn't load your apps"
              onRetry={() => refetch()}
            />
          ) : filtered.length === 0 ? (
            <EmptyState
              className="min-h-[40vh]"
              icon={AppWindow}
              title={
                hasActiveFilters
                  ? "No apps match your search"
                  : "No apps here yet"
              }
              description={
                hasActiveFilters
                  ? "Try adjusting your search or filters."
                  : "Create an app to get started."
              }
              onClearFilters={hasActiveFilters ? clearFilters : undefined}
            />
          ) : (
            <div className="space-y-6">
              <AppSection
                title="Pinned"
                apps={pinnedApps}
                onOpenSettings={openSettings}
              />
              <AppSection
                title="Apps"
                apps={ownedApps}
                onOpenSettings={openSettings}
              />
              <AppSection
                title="Apps from installed MCP servers"
                apps={externalApps}
                onOpenSettings={openSettings}
              />
            </div>
          )}
        </LoadingWrapper>

        <AppCreateDialog open={createOpen} onOpenChange={setCreateOpen} />

        {settingsApp ? (
          <AppSettingsDialog
            appId={settingsApp.id}
            open={!!settingsApp}
            onOpenChange={(open) => {
              if (!open) closeSettings();
            }}
          />
        ) : null}
      </TableCardView>
    </PageLayout>
  );
}

// Mirrors the Projects page's ProjectSection: an uppercase header over the
// card grid (or table, in table view). Renders nothing when the group is
// empty, so only sections with entries appear.
/**
 * One key's row in the label filter popover. Values are fetched lazily, only
 * once its sub-popover opens.
 */
function AppLabelKeyRow({
  labelKey,
  selectedValues,
  onToggleValue,
}: {
  labelKey: string;
  selectedValues: string[];
  onToggleValue: (key: string, value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const { data: values } = useAppLabelValues({
    key: open ? labelKey : undefined,
  });
  return (
    <LabelKeyRowBase
      labelKey={labelKey}
      selectedValues={selectedValues}
      onToggleValue={onToggleValue}
      values={values}
      onOpenChange={setOpen}
    />
  );
}

export function AppSection({
  title,
  apps,
  onOpenSettings,
}: {
  title: string;
  apps: AppListItem[];
  onOpenSettings: (app: { id: string }) => void;
}) {
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);
  const [bulkVisibilityOpen, setBulkVisibilityOpen] = useState(false);
  const bulkDelete = useBulkDeleteApps();
  const bulkVisibility = useBulkUpdateAppVisibility();
  const {
    rowSelection,
    setRowSelection,
    onPageRowIdsChange,
    clearSelection,
    selected,
    selectAllMatching,
    rangeSelection,
  } = useBulkSelection({
    rows: apps,
    getId: getAppRowKey,
    canSelect: (app) => app.source === "owned",
    filterSignature: `${title}:${apps.map(getAppRowKey).join(",")}`,
    matchDescription: "were built here",
  });
  const cardSelection = useBulkCardSelection({
    rows: apps,
    getRowId: getAppRowKey,
    rowSelection,
    setRowSelection,
    canSelect: (app) => app.source === "owned",
    rangeSelection,
  });
  const selectedOwnedApps = selected.filter(
    (app): app is OwnedApp => app.source === "owned",
  );
  const selectedApps = selectedOwnedApps.map((app) => ({
    id: app.id,
    name: app.name,
  }));

  if (apps.length === 0) return null;

  return (
    <section className="space-y-3">
      <h2 className="text-sm font-medium uppercase tracking-wide text-muted-foreground">
        {title}
      </h2>
      <BulkActions
        count={selectedApps.length}
        noun="app"
        onClear={clearSelection}
        busy={bulkDelete.isPending}
        selectAllMatching={selectAllMatching}
      >
        <PermissionButton
          permissions={{ app: ["update"] }}
          variant="outline"
          size="sm"
          onClick={() => setBulkVisibilityOpen(true)}
        >
          <span>Edit visibility</span>
        </PermissionButton>
        <PermissionButton
          permissions={{ app: ["delete"] }}
          variant="destructive"
          size="sm"
          onClick={() => setBulkDeleteOpen(true)}
        >
          <Trash2 className="h-4 w-4" />
          <span>Delete</span>
        </PermissionButton>
      </BulkActions>
      <TableCardViewContent
        table={
          <AppsTable
            apps={apps}
            onOpenSettings={onOpenSettings}
            rowSelection={rowSelection}
            setRowSelection={setRowSelection}
            onPageRowIdsChange={onPageRowIdsChange}
            rangeSelection={rangeSelection}
          />
        }
        cards={
          <TableCardSelectionScope
            rowIds={apps
              .filter((app) => app.source === "owned")
              .map(getAppRowKey)}
            onVisibleRowIdsChange={onPageRowIdsChange}
          >
            <TableCardGrid>
              {apps.map((app) => (
                <AppCard
                  key={getAppRowKey(app)}
                  app={app}
                  onOpenSettings={onOpenSettings}
                  selection={app.source === "owned" ? cardSelection(app) : null}
                />
              ))}
            </TableCardGrid>
          </TableCardSelectionScope>
        }
      />

      {bulkDeleteOpen && (
        <DeleteConfirmDialog
          open={bulkDeleteOpen}
          onOpenChange={setBulkDeleteOpen}
          title="Delete apps"
          description={`Delete ${selectedApps.length} ${
            selectedApps.length === 1 ? "app" : "apps"
          }? This cannot be undone.`}
          isPending={bulkDelete.isPending}
          onConfirm={() => {
            bulkDelete.mutate(selectedApps, {
              onSuccess: (outcome) => {
                reportBulkOutcome({
                  outcome,
                  verb: "Deleted",
                  failureVerb: "delete",
                  noun: "app",
                });
                setBulkDeleteOpen(false);
                if (outcome.failed.length === 0) clearSelection();
              },
            });
          }}
          confirmLabel="Delete apps"
          pendingLabel="Deleting..."
        />
      )}

      {bulkVisibilityOpen && (
        <BulkVisibilityDialog
          open={bulkVisibilityOpen}
          onOpenChange={setBulkVisibilityOpen}
          noun="app"
          isPending={bulkVisibility.isPending}
          items={selectedOwnedApps.map((app) => ({
            id: app.id,
            scope: app.scope,
            teams: [],
            users: [],
          }))}
          onApply={async (change) => {
            const outcome = await bulkVisibility.mutateAsync({
              apps: selectedApps,
              scope: change.scope,
              teamIds: change.teamIds,
              userIds: change.userIds,
            });
            reportBulkOutcome({
              outcome,
              verb: "Updated",
              failureVerb: "update",
              noun: "app",
            });
            if (outcome.succeeded.length === 0) return false;
            if (outcome.failed.length === 0) clearSelection();
            return true;
          }}
        />
      )}
    </section>
  );
}

// "Apps" are authored inside the platform (source "owned"); "MCP Server Apps"
// are ui:// resources exposed by installed external MCP servers (source
// "external"). Exported for tests.
export function matchesKind(app: AppListItem, kind: string): boolean {
  if (kind === "owned") return app.source === "owned";
  if (kind === "external") return app.source === "external";
  return true;
}
