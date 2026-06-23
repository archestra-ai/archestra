"use client";

import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { AppFrame } from "@/components/mcp-app/app-frame";
import { Button } from "@/components/ui/button";
import { useApps } from "@/lib/app.query";

// Full-page standalone runtime for an external UI-providing MCP server. The
// resource uri + name are resolved from the unified Apps list (which the user
// came from, and which refetches on a deep link).
export default function ServerAppRunPage({
  mcpServerId,
}: {
  mcpServerId: string;
}) {
  // Match the Apps list page size: an external card is only clickable when it's
  // in the listing, so the same window resolves it. (GET /api/apps caps at 100.)
  const { data, isPending } = useApps({ limit: 100, offset: 0 });
  const items = data?.data ?? [];
  const item = items.find(
    (entry) => entry.source === "external" && entry.mcpServerId === mcpServerId,
  );

  if (!isPending && !item) {
    return (
      <div className="flex h-screen items-center justify-center p-8 text-center text-sm text-muted-foreground">
        This app does not exist or you do not have access to it.
      </div>
    );
  }

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
          {item?.name ?? "App"}
        </span>
      </header>
      <main className="min-h-0 flex-1 overflow-auto">
        {item && item.source === "external" ? (
          <AppFrame
            endpoint={{ kind: "server", mcpServerId }}
            resourceUri={item.resourceUri}
            chrome={false}
          />
        ) : null}
      </main>
    </div>
  );
}
