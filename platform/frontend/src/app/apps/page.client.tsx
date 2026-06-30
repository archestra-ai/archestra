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

  // Temporarily hiding external (MCP-server-backed) apps; only owned apps show.
  const apps = useMemo(
    () => (data?.data ?? []).filter((app) => app.source === "owned"),
    [data],
  );
  const filtered = useMemo(
    () => apps.filter((app) => matchesFilter(app, filter, currentUserId)),
    [apps, filter, currentUserId],
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
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">
            {filtered.map((app) => (
              <AppCard key={app.id} app={app} currentUserId={currentUserId} />
            ))}
          </div>
        )}
      </LoadingWrapper>

      <AppCreateDialog open={createOpen} onOpenChange={setCreateOpen} />
    </PageLayout>
  );
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
      : app.availabilityScopes.includes("personal");
  if (filter === "team")
    return app.source === "owned"
      ? app.scope === "team"
      : app.availabilityScopes.includes("team");
  if (filter === "org")
    return app.source === "owned"
      ? app.scope === "org"
      : app.availabilityScopes.includes("org");
  return true;
}
