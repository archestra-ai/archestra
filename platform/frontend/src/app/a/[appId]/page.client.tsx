"use client";

import { useEffect } from "react";
import { AppFrame } from "@/components/mcp-app/app-frame";
import { useApp } from "@/lib/app.query";

// Full-page standalone runtime: just the app, no Archestra chrome. The app name
// goes to the browser tab title, like any standalone web app.
export default function AppRunPage({ appId }: { appId: string }) {
  const { data: app, isPending } = useApp(appId);

  useEffect(() => {
    if (app?.name) document.title = app.name;
  }, [app?.name]);

  // Mount only once resolved so the runtime keys diagnostics to a concrete
  // version — AppFrame renders the bare runtime and doesn't gate on it.
  if (!app) {
    return isPending ? null : (
      <div className="flex h-screen items-center justify-center p-8 text-center text-sm text-muted-foreground">
        This app does not exist or you do not have access to it.
      </div>
    );
  }

  return (
    <div className="h-screen w-full">
      <AppFrame endpoint={{ kind: "app", appId }} fillContainer />
    </div>
  );
}
