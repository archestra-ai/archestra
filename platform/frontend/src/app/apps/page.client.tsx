"use client";

import { AppWindow, Plus, Trash2 } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useState } from "react";
import { LoadingWrapper } from "@/components/loading";
import { PageLayout } from "@/components/page-layout";
import { ResourceVisibilityBadge } from "@/components/resource-visibility-badge";
import { SearchInput } from "@/components/search-input";
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { PermissionButton } from "@/components/ui/permission-button";
import { useApps, useDeleteApp } from "@/lib/app.query";
import { useSession } from "@/lib/auth/auth.query";
import { AppCreateDialog } from "./_parts/app-create-dialog";

const PAGE_SIZE = 100;

export default function AppsPage() {
  const search = useSearchParams().get("search") ?? "";
  const { data: session } = useSession();
  const { data, isPending } = useApps({
    limit: PAGE_SIZE,
    offset: 0,
    search: search || undefined,
  });
  const deleteApp = useDeleteApp();
  const [createOpen, setCreateOpen] = useState(false);

  const apps = data?.data ?? [];

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
          New app
        </PermissionButton>
      }
    >
      <div className="mb-6">
        <SearchInput
          paramName="search"
          objectNamePlural="apps"
          searchFields={["name", "description"]}
          className="relative w-[370px]"
        />
      </div>

      <LoadingWrapper isPending={isPending && !data}>
        {apps.length === 0 ? (
          <div className="flex min-h-[40vh] flex-col items-center justify-center text-center">
            <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl border bg-background shadow-sm">
              <AppWindow className="h-6 w-6 text-primary" />
            </div>
            <h2 className="mb-1 text-lg font-semibold">
              {search ? "No apps match your search" : "No apps yet"}
            </h2>
            <p className="max-w-sm text-sm text-muted-foreground">
              Create an app from a template to get started.
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {apps.map((app) => (
              <Card key={app.id} className="group relative">
                <Link
                  href={`/apps/${app.id}`}
                  className="absolute inset-0"
                  aria-label={`Open ${app.name}`}
                />
                <CardHeader>
                  <div className="flex items-start justify-between gap-2">
                    <CardTitle className="truncate">{app.name}</CardTitle>
                    <ResourceVisibilityBadge
                      scope={app.scope}
                      teams={undefined}
                      authorId={app.authorId}
                      authorName={undefined}
                      currentUserId={session?.user?.id}
                    />
                  </div>
                  {app.description ? (
                    <CardDescription className="line-clamp-2">
                      {app.description}
                    </CardDescription>
                  ) : null}
                </CardHeader>
                <div className="pointer-events-none absolute bottom-3 right-3 opacity-0 transition-opacity group-hover:opacity-100">
                  <PermissionButton
                    permissions={{ app: ["delete"] }}
                    variant="ghost"
                    size="icon"
                    className="pointer-events-auto relative z-10 h-8 w-8 text-muted-foreground hover:text-destructive"
                    aria-label={`Delete ${app.name}`}
                    onClick={(e) => {
                      e.preventDefault();
                      if (
                        confirm(`Delete "${app.name}"? This cannot be undone.`)
                      )
                        deleteApp.mutate(app.id);
                    }}
                  >
                    <Trash2 className="h-4 w-4" />
                  </PermissionButton>
                </div>
              </Card>
            ))}
          </div>
        )}
      </LoadingWrapper>

      <AppCreateDialog open={createOpen} onOpenChange={setCreateOpen} />
    </PageLayout>
  );
}
