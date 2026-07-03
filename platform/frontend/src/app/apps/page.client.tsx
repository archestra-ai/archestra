"use client";

import type { archestraApiTypes } from "@archestra/shared";
import { AppWindow, Plus } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useMemo, useState } from "react";
import { LoadingWrapper } from "@/components/loading";
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
import { useSession } from "@/lib/auth/auth.query";
import { AppCard } from "./_parts/app-card";
import { AppCreateDialog } from "./_parts/app-create-dialog";

const PAGE_SIZE = 100;

type AppListItem = archestraApiTypes.GetAppsResponses["200"]["data"][number];

export default function AppsPage() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const search = searchParams.get("search") ?? "";
  const filter = searchParams.get("filter") ?? "all";
  const kind = searchParams.get("kind") ?? "all";

  const { data: session } = useSession();
  const currentUserId = session?.user?.id;
  const { data, isPending, isLoadingError, refetch } = useApps(
    {
      limit: PAGE_SIZE,
      offset: 0,
      search: search || undefined,
    },
    { toastOnError: false },
  );
  const [createOpen, setCreateOpen] = useState(false);

  // Pinned-first grouping applies on top of the scope filter, mirroring the
  // Projects page: a "Pinned" section above, everything else below.
  const filtered = useMemo(
    () =>
      sortAppsPinnedFirst(
        (data?.data ?? []).filter(
          (app) =>
            matchesKind(app, kind) && matchesFilter(app, filter, currentUserId),
        ),
      ),
    [data, kind, filter, currentUserId],
  );
  const pinnedApps = filtered.filter((app) => app.pinnedAt);
  const unpinnedApps = filtered.filter((app) => !app.pinnedAt);

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
          value={filter}
          onValueChange={(value) =>
            setParam("filter", value === "all" ? null : value)
          }
        >
          <SelectTrigger className="w-[160px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent position="popper" side="bottom" align="start">
            <SelectItem value="all">All apps</SelectItem>
            <SelectItem value="personal">Personal</SelectItem>
            <SelectItem value="team">Team</SelectItem>
            <SelectItem value="org">Organization</SelectItem>
          </SelectContent>
        </Select>
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
            {pinnedApps.length > 0 && (
              <AppSection title="Pinned" apps={pinnedApps} />
            )}
            <AppSection
              title={pinnedApps.length > 0 ? "All apps" : undefined}
              apps={unpinnedApps}
            />
          </div>
        )}
      </LoadingWrapper>

      <AppCreateDialog open={createOpen} onOpenChange={setCreateOpen} />
    </PageLayout>
  );
}

// Mirrors the Projects page's ProjectSection: an optional uppercase header over
// the card grid, used to split "Pinned" from the rest.
function AppSection({ title, apps }: { title?: string; apps: AppListItem[] }) {
  if (apps.length === 0) return null;

  return (
    <section className="space-y-3">
      {title ? (
        <h2 className="text-sm font-medium uppercase tracking-wide text-muted-foreground">
          {title}
        </h2>
      ) : null}
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
          />
        ))}
      </div>
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

function matchesFilter(
  app: AppListItem,
  filter: string,
  currentUserId: string | undefined,
): boolean {
  if (filter === "all") return true;
  if (filter === "personal")
    return app.source === "owned"
      ? app.scope === "personal" &&
          !!currentUserId &&
          app.authorId === currentUserId
      : app.scope === "personal";
  if (filter === "team") return app.scope === "team";
  if (filter === "org") return app.scope === "org";
  return true;
}
