"use client";

import { E2eTestId } from "@archestra/shared";
import { AlertTriangle, RefreshCw, WifiOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { InlineNotice, InlineNoticeText } from "@/components/ui/inline-notice";
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
    case "database-unavailable":
      return "Database connection unavailable.";
  }
}

/**
 * Persistent banner for the authenticated shell, shown while the browser is
 * offline, the backend is unreachable, or the database is unavailable. Complements the per-screen
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
    <InlineNotice data-testid={E2eTestId.ConnectivityStatusBar}>
      {state.kind === "database-unavailable" ? <AlertTriangle /> : <WifiOff />}
      <span className="font-medium">{messageFor(state.kind, appName)}</span>
      {state.kind === "database-unavailable" && (
        <InlineNoticeText>
          Check the database service and connection settings, then retry.
        </InlineNoticeText>
      )}
      <Button
        size="sm"
        variant="outline"
        className="ml-auto"
        data-testid={E2eTestId.ConnectivityStatusBarRetry}
        onClick={onRetry}
      >
        <RefreshCw className="h-4 w-4" />
        Retry
      </Button>
    </InlineNotice>
  );
}
