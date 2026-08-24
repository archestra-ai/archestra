"use client";

import type { archestraApiTypes } from "@archestra/shared";
import { AppWindow, Plus } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useMemo, useState } from "react";
import {
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
  TableCardView,
  TableCardViewContent,
  TableCardViewToggle,
} from "@/components/table-card-view";
import { PermissionButton } from "@/components/ui/permission-button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useAppLabelKeys, useAppLabelValues, useApps } from "@/lib/app.query";
import { sortAppsPinnedFirst } from "@/lib/apps/app-sort";
import { useDialogUrlParam } from "@/lib/hooks/use-dialog-url-param";
import { AppCard } from "./_parts/app-card";
import { AppCreateDialog } from "./_parts/app-create-dialog";
import { AppsTable } from "./_parts/apps-table";

const PAGE_SIZE = 100;

type AppListItem = archestraApiTypes.GetAppsResponses["200"]["data"][number];

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
        <FilterBar className="mb-6" actions={<TableCardViewToggle />}>
          <SearchInput
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
          <div className="mb-6">
            <LabelFilterBadges onRemoveLabel={handleRemoveLabel} />
          </div>
        )}

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
            <div className="flex min-h-[40vh] flex-col items-center justify-center text-center">
              <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl border bg-background shadow-sm">
                <AppWindow className="h-6 w-6 text-primary" />
              </div>
              <h2 className="mb-1 text-lg font-semibold">
                {search ? "No apps match your search" : "No apps here yet"}
              </h2>
              <p className="max-w-sm text-sm text-muted-foreground">
                Create an app to get started.
              </p>
            </div>
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

function AppSection({
  title,
  apps,
  onOpenSettings,
}: {
  title: string;
  apps: AppListItem[];
  onOpenSettings: (app: { id: string }) => void;
}) {
  if (apps.length === 0) return null;

  return (
    <section className="space-y-3">
      <h2 className="text-sm font-medium uppercase tracking-wide text-muted-foreground">
        {title}
      </h2>
      <TableCardViewContent
        table={<AppsTable apps={apps} onOpenSettings={onOpenSettings} />}
        cards={
          <TableCardGrid>
            {apps.map((app) => (
              <AppCard
                // Several tools of one server can share a widget resource, so
                // (mcpServerId, resourceUri) alone collides; duplicate keys make
                // React duplicate/omit cards on search re-renders, breaking the
                // grid. The tool-scoped name disambiguates.
                key={
                  app.source === "owned"
                    ? app.id
                    : `${app.mcpServerId}:${app.resourceUri}:${app.name}`
                }
                app={app}
                onOpenSettings={onOpenSettings}
              />
            ))}
          </TableCardGrid>
        }
      />
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
