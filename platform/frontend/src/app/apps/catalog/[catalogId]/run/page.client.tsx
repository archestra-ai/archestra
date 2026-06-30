"use client";

import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect } from "react";
import { AppFrame } from "@/components/mcp-app/app-frame";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useExternalApp } from "@/lib/app.query";

type Install = {
  mcpServerId: string;
  scope: "personal" | "team" | "org";
  name: string;
};

const SCOPE_LABEL: Record<Install["scope"], string> = {
  personal: "Personal",
  team: "Team",
  org: "Organization",
};

// Full-page standalone runtime for an external UI-providing app, keyed by its
// catalog item. An external app runs server-scoped against one concrete
// install; the caller picks which (default personal → team → org), carried in
// `?install=` so a shared link reopens the sender's install (mcp-apps.md FR-31).
export default function CatalogAppRunPage({
  catalogId,
}: {
  catalogId: string;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const requestedInstall = searchParams.get("install");
  const { data, isPending } = useExternalApp(catalogId);

  const installs = data?.installs ?? [];
  const activeInstallId =
    (requestedInstall &&
    installs.some((i) => i.mcpServerId === requestedInstall)
      ? requestedInstall
      : data?.defaultMcpServerId) ?? null;

  // A catalog the caller can see but has no accessible install for is listable
  // but not runnable: send them to install rather than render (FR-31).
  useEffect(() => {
    if (!isPending && data && !activeInstallId) {
      router.replace(`/mcp/registry?search=${encodeURIComponent(data.name)}`);
    }
  }, [isPending, data, activeInstallId, router]);

  if (!isPending && !data) {
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-4 p-8 text-center">
        <p className="text-sm text-muted-foreground">
          This app does not exist or you do not have access to it.
        </p>
        <Button asChild variant="outline" size="sm">
          <Link href="/apps">
            <ArrowLeft className="h-4 w-4" />
            Back to Apps
          </Link>
        </Button>
      </div>
    );
  }

  const selectInstall = (mcpServerId: string) => {
    const params = new URLSearchParams(searchParams);
    params.set("install", mcpServerId);
    router.replace(`/apps/catalog/${catalogId}/run?${params.toString()}`);
  };

  return (
    <div className="flex h-screen flex-col">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b px-4">
        <Button asChild variant="ghost" size="sm">
          <Link href="/apps">
            <ArrowLeft className="h-4 w-4" />
            Back
          </Link>
        </Button>
        <span className="truncate text-sm font-medium">
          {data?.name ?? "App"}
        </span>
        {installs.length > 1 && activeInstallId ? (
          <div className="ml-auto">
            <Select value={activeInstallId} onValueChange={selectInstall}>
              <SelectTrigger className="h-8 w-[240px]" aria-label="Run as">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {installs.map((install) => (
                  <SelectItem
                    key={install.mcpServerId}
                    value={install.mcpServerId}
                  >
                    {SCOPE_LABEL[install.scope]} · {install.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        ) : null}
      </header>
      <main className="min-h-0 flex-1 overflow-auto">
        {data && activeInstallId ? (
          <AppFrame
            endpoint={{ kind: "server", mcpServerId: activeInstallId }}
            resourceUri={data.resourceUri}
          />
        ) : null}
      </main>
    </div>
  );
}
