"use client";

import { useEffect } from "react";
import { LoadingState } from "@/components/loading";
import { AppFrame } from "@/components/mcp-app/app-frame";
import { QueryLoadError } from "@/components/query-load-error";
import { useApp } from "@/lib/app.query";

// Full-page standalone runtime: just the app, no Archestra chrome. The app name
// goes to the browser tab title, like any standalone web app.
//
// `idOrSlug` is whatever the URL carried — a custom slug or the app id. Only the
// lookup accepts both; the runtime below is mounted on the resolved `app.id`.
export default function AppRunPage({ idOrSlug }: { idOrSlug: string }) {
  const {
    data: app,
    isPending,
    isLoadingError,
    refetch,
  } = useApp(idOrSlug, { toastOnError: false });

  useEffect(() => {
    if (app?.name) document.title = app.name;
  }, [app?.name]);

  if (isPending) {
    return (
      <LoadingState
        className="h-app-viewport"
        label="Loading app…"
        variant="page"
      />
    );
  }

  if (isLoadingError) {
    return (
      <QueryLoadError
        title="Couldn't load this app"
        onRetry={() => refetch()}
        className="h-app-viewport"
      />
    );
  }

  // Mount only once resolved so the runtime keys diagnostics to a concrete
  // version — AppFrame renders the bare runtime and doesn't gate on it.
  if (!app) {
    return (
      <output className="flex h-app-viewport items-center justify-center p-8 text-center text-sm text-muted-foreground">
        This app does not exist, or it is not shared with you. If you expected
        to see it, ask its owner to share it with your team or organization.
      </output>
    );
  }

  return (
    <div className="h-app-viewport w-full">
      {/* app.id, never the URL segment: the runtime endpoint is uuid-keyed and
          the id is the app's isolation key (data store, tool gate, audience). */}
      <AppFrame endpoint={{ kind: "app", appId: app.id }} fillContainer />
    </div>
  );
}
