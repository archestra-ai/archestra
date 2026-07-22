"use client";

import type { archestraApiTypes } from "@archestra/shared";
import { AppWindow, Plus } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useMemo, useState } from "react";
import {
  type ListViewMode,
  ListViewToggle,
  useListViewMode,
} from "@/components/list-view-toggle";
import { LoadingWrapper } from "@/components/loading";
import { AppSettingsDialog } from "@/components/mcp-app/app-settings-dialog";
import { PageLayout } from "@/components/page-layout";
import { QueryLoadError } from "@/components/query-load-error";
import { SearchInput } from "@/components/search-input";
import { PermissionButton } from "@/components/ui/permission-button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useApps } from "@/lib/app.query";
import { sortAppsPinnedFirst } from "@/lib/apps/app-sort";
import { useDialogUrlParam } from "@/lib/hooks/use-dialog-url-param";
import { AppCard } from "./_parts/app-card";
import { AppCreateDialog } from "./_parts/app-create-dialog";
import { AppsScopeFilter } from "./_parts/apps-scope-filter";
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
  const scope = searchParams.get("scope") ?? undefined;
  const authorIdsParam = searchParams.get("authorIds");
  const excludeAuthorIdsParam = searchParams.get("excludeAuthorIds");
  const settingsId = searchParams.get("settings");

  const { data, isPending, isLoadingError, refetch } = useApps(
    {
      limit: PAGE_SIZE,
      offset: 0,
      search: search || undefined,
      scope: (scope as "personal" | "team" | "org" | undefined) ?? undefined,
      authorIds: authorIdsParam ? authorIdsParam.split(",") : undefined,
      excludeAuthorIds: excludeAuthorIdsParam
        ? excludeAuthorIdsParam.split(",")
        : undefined,
    },
    { toastOnError: false },
  );
  const [createOpen, setCreateOpen] = useState(false);
  const [viewMode, setViewMode] = useListViewMode("archestra-apps-view");

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
      <div className="mb-6 flex flex-wrap items-center gap-2">
        <SearchInput
          paramName="search"
          placeholder="Search apps"
          className="relative mr-1 w-[280px]"
        />
        <Select
          value={kind}
          onValueChange={(value) =>
            setParam("kind", value === "all" ? null : value)
          }
        >
          <SelectTrigger className="w-[160px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent position="popper" side="bottom" align="start">
            <SelectItem value="all">All kinds</SelectItem>
            <SelectItem value="owned">Apps</SelectItem>
            <SelectItem value="external">MCP Server Apps</SelectItem>
          </SelectContent>
        </Select>
        <AppsScopeFilter />
        <span className="ml-auto">
          <ListViewToggle value={viewMode} onChange={setViewMode} />
        </span>
      </div>

      <LoadingWrapper isPending={isPending && !data}>
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
              viewMode={viewMode}
              onOpenSettings={openSettings}
            />
            <AppSection
              title="Apps"
              apps={ownedApps}
              viewMode={viewMode}
              onOpenSettings={openSettings}
            />
            <AppSection
              title="Apps from installed MCP servers"
              apps={externalApps}
              viewMode={viewMode}
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
    </PageLayout>
  );
}

// Mirrors the Projects page's ProjectSection: an uppercase header over the
// card grid (or table, in table view). Renders nothing when the group is
// empty, so only sections with entries appear.
function AppSection({
  title,
  apps,
  viewMode,
  onOpenSettings,
}: {
  title: string;
  apps: AppListItem[];
  viewMode: ListViewMode;
  onOpenSettings: (app: { id: string }) => void;
}) {
  if (apps.length === 0) return null;

  return (
    <section className="space-y-3">
      <h2 className="text-sm font-medium uppercase tracking-wide text-muted-foreground">
        {title}
      </h2>
      {viewMode === "table" ? (
        <AppsTable apps={apps} onOpenSettings={onOpenSettings} />
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
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
        </div>
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
