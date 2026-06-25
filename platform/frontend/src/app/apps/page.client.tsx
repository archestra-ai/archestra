"use client";

import type { archestraApiTypes } from "@archestra/shared";
import {
  AppWindow,
  Globe,
  LayoutGrid,
  Plus,
  Server,
  Sparkles,
  User,
} from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useMemo, useState } from "react";
import { LoadingWrapper } from "@/components/loading";
import { PageLayout } from "@/components/page-layout";
import { scopeStyles } from "@/components/resource-visibility-badge";
import { SearchInput } from "@/components/search-input";
import { Button } from "@/components/ui/button";
import { PermissionButton } from "@/components/ui/permission-button";
import { useApps, useDeleteApp } from "@/lib/app.query";
import { useSession } from "@/lib/auth/auth.query";
import { cn } from "@/lib/utils";
import { AppCard } from "./_parts/app-card";
import { AppCreateDialog } from "./_parts/app-create-dialog";

const PAGE_SIZE = 100;

type AppListItem = archestraApiTypes.GetAppsResponses["200"]["data"][number];
type TabValue = "apps" | "external";

export default function AppsPage() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const search = searchParams.get("search") ?? "";
  const tab: TabValue =
    searchParams.get("tab") === "external" ? "external" : "apps";
  const filter = searchParams.get("filter") ?? "all";

  const { data: session } = useSession();
  const currentUserId = session?.user?.id;
  const { data, isPending } = useApps({
    limit: PAGE_SIZE,
    offset: 0,
    search: search || undefined,
  });
  const deleteApp = useDeleteApp();
  const [createOpen, setCreateOpen] = useState(false);

  const apps = useMemo(() => data?.data ?? [], [data]);
  const owned = useMemo(() => apps.filter((a) => a.source === "owned"), [apps]);
  const external = useMemo(
    () => apps.filter((a) => a.source === "external"),
    [apps],
  );

  const tabApps = tab === "external" ? external : owned;
  const filtered = useMemo(
    () => tabApps.filter((app) => matchesFilter(app, filter, currentUserId)),
    [tabApps, filter, currentUserId],
  );

  const setParam = (name: string, value: string | null) => {
    const params = new URLSearchParams(searchParams.toString());
    if (value) params.set(name, value);
    else params.delete(name);
    router.push(`${pathname}?${params.toString()}`, { scroll: false });
  };

  const showCreateCard = tab === "apps" && !search;

  return (
    <PageLayout
      title="Apps"
      description="Build and run sandboxed MCP Apps backed by their own data store and tools."
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
      <div className="mb-5 flex items-center gap-5 border-b border-border">
        {(
          [
            { value: "apps", label: "Apps", count: owned.length, icon: null },
            {
              value: "external",
              label: "External",
              count: external.length,
              icon: Server,
            },
          ] as const
        ).map((t) => {
          const isActive = tab === t.value;
          return (
            <button
              key={t.value}
              type="button"
              onClick={() =>
                setParam("tab", t.value === "apps" ? null : t.value)
              }
              className={cn(
                "relative -mb-px flex cursor-pointer items-center gap-1.5 pb-3 text-sm font-medium transition-colors hover:text-foreground",
                isActive ? "text-foreground" : "text-muted-foreground",
              )}
            >
              {t.icon && <t.icon className="h-4 w-4" />}
              {t.label} <span className="text-muted-foreground">{t.count}</span>
              {isActive && (
                <span className="absolute bottom-0 left-0 right-0 h-0.5 bg-primary" />
              )}
            </button>
          );
        })}
      </div>

      <div className="mb-6 flex flex-wrap items-center gap-2">
        <SearchInput
          paramName="search"
          placeholder="Search apps"
          className="relative mr-1 w-[280px]"
        />
        {[
          { value: "all", label: "All", icon: LayoutGrid, activeStyle: null },
          {
            value: "mine",
            label: "Mine",
            icon: User,
            activeStyle: scopeStyles.personal,
          },
          {
            value: "org",
            label: "Organization",
            icon: Globe,
            activeStyle: scopeStyles.org,
          },
        ].map((pill) => {
          const isActive = filter === pill.value;
          const Icon = pill.icon;
          return (
            <button
              key={pill.value}
              type="button"
              onClick={() =>
                setParam("filter", pill.value === "all" ? null : pill.value)
              }
              className={cn(
                "inline-flex cursor-pointer items-center gap-1.5 rounded-full border px-3 py-1 text-sm font-medium transition-colors",
                isActive
                  ? (pill.activeStyle ??
                      "border-primary/20 bg-primary/10 text-primary")
                  : "border-border bg-background text-muted-foreground hover:bg-muted",
              )}
            >
              <Icon className="h-3.5 w-3.5" />
              {pill.label}
            </button>
          );
        })}
      </div>

      <LoadingWrapper isPending={isPending && !data}>
        {filtered.length === 0 && !showCreateCard ? (
          <div className="flex min-h-[40vh] flex-col items-center justify-center text-center">
            <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl border bg-background shadow-sm">
              <AppWindow className="h-6 w-6 text-primary" />
            </div>
            <h2 className="mb-1 text-lg font-semibold">
              {search
                ? "No apps match your search"
                : tab === "external"
                  ? "No external apps"
                  : "No apps here yet"}
            </h2>
            <p className="max-w-sm text-sm text-muted-foreground">
              {tab === "external"
                ? "Installed MCP servers that provide a UI show up here."
                : "Create an app to get started."}
            </p>
            {tab === "external" && !search ? (
              <Button asChild variant="outline" className="mt-4">
                <Link href="/mcp/registry">Manage MCP servers</Link>
              </Button>
            ) : null}
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {showCreateCard ? (
              <button
                type="button"
                onClick={() => setCreateOpen(true)}
                className="flex min-h-[194px] cursor-pointer flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-border bg-muted/30 p-5 text-center transition-colors hover:bg-muted/50"
              >
                <span className="flex h-12 w-12 items-center justify-center rounded-full bg-primary/10 text-primary">
                  <Sparkles className="h-5 w-5" />
                </span>
                <span className="text-sm font-semibold">Create app</span>
                <span className="text-xs text-muted-foreground">
                  Describe it — we build it
                </span>
              </button>
            ) : null}
            {filtered.map((app) => (
              <AppCard
                key={app.source === "external" ? app.catalogId : app.id}
                app={app}
                currentUserId={currentUserId}
                onDelete={(owned) => {
                  if (confirm(`Delete "${owned.name}"? This cannot be undone.`))
                    deleteApp.mutate(owned.id);
                }}
              />
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
  if (filter === "mine")
    return (
      app.source === "owned" &&
      !!currentUserId &&
      app.authorId === currentUserId
    );
  if (filter === "org")
    return app.source === "owned"
      ? app.scope === "org"
      : app.availabilityScopes.includes("org");
  return true;
}
