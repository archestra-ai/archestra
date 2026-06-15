"use client";

import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { useApp } from "@/lib/app.query";
import { AppRuntimeFrame } from "../../_parts/app-runtime-frame";

// Full-page standalone runtime: no chat chrome, just the app and a way back.
export default function AppRunPage({ appId }: { appId: string }) {
  const { data: app, isPending } = useApp(appId);

  if (!isPending && !app) {
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
          <Link href={`/apps/${appId}`}>
            <ArrowLeft className="h-4 w-4" />
            Back
          </Link>
        </Button>
        <span className="truncate text-sm font-medium">
          {app?.name ?? "App"}
        </span>
      </header>
      <main className="min-h-0 flex-1 overflow-auto">
        <AppRuntimeFrame appId={appId} />
      </main>
    </div>
  );
}
