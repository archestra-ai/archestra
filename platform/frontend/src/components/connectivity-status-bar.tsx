"use client";

import { E2eTestId } from "@archestra/shared";
import { RefreshCw, WifiOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { ConnectivityState } from "@/lib/config/connectivity";

function messageFor(
  kind: Exclude<ConnectivityState["kind"], "online">,
  appName: string,
): string {
  switch (kind) {
    case "browser-offline":
      return "You're offline. Some features won't work until you reconnect.";
    case "backend-unreachable":
      return `Can't reach the ${appName} server.`;
  }
}

/**
 * Persistent banner for the authenticated shell, shown while the browser is
 * offline or the backend is unreachable. Complements the per-screen
 * QueryLoadError panels: those keep a blocked surface locally actionable, this
 * explains the app-wide condition. Renders nothing while online.
 */
export function ConnectivityStatusBar({
  state,
  onRetry,
  appName,
}: {
  state: ConnectivityState;
  onRetry: () => void;
  appName: string;
}) {
  if (state.kind === "online") {
    return null;
  }

  return (
    <div
      data-testid={E2eTestId.ConnectivityStatusBar}
      className="bg-amber-100 dark:bg-amber-900/40 border-b border-amber-300 dark:border-amber-800 text-amber-900 dark:text-amber-100 px-4 py-2 flex items-center justify-between gap-4"
    >
      <span className="flex items-center gap-2 text-sm font-medium">
        <WifiOff className="h-4 w-4 shrink-0" />
        {messageFor(state.kind, appName)}
      </span>
      <Button
        size="sm"
        variant="outline"
        data-testid={E2eTestId.ConnectivityStatusBarRetry}
        onClick={onRetry}
      >
        <RefreshCw className="h-4 w-4" />
        Retry
      </Button>
    </div>
  );
}
