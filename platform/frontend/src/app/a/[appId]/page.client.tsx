"use client";

import { useEffect } from "react";
import { AppFrame } from "@/components/mcp-app/app-frame";
import { QueryLoadError } from "@/components/query-load-error";
import { useApp } from "@/lib/app.query";

// Full-page standalone runtime: just the app, no Archestra chrome. The app name
// goes to the browser tab title, like any standalone web app.
export default function AppRunPage({ appId }: { appId: string }) {
  const {
    data: app,
    isPending,
    isLoadingError,
    refetch,
  } = useApp(appId, { toastOnError: false });

  useEffect(() => {
    if (app?.name) document.title = app.name;
  }, [app?.name]);

  if (isLoadingError) {
    return (
      <QueryLoadError
        title="Couldn't load this app"
        onRetry={() => refetch()}
        className="h-screen"
      />
    );
  }

  // Mount only once resolved so the runtime keys diagnostics to a concrete
  // version — AppFrame renders the bare runtime and doesn't gate on it.
  if (!app) {
    return isPending ? null : (
      <output className="flex h-screen items-center justify-center p-8 text-center text-sm text-muted-foreground">
        This app does not exist or you do not have access to it.
      </output>
    );
  }

  return (
    <div className="h-screen w-full">
      <AppFrame endpoint={{ kind: "app", appId }} fillContainer />
    </div>
  );
}
