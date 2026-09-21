"use client";

import { E2eTestId } from "@archestra/shared";
import { AlertTriangle, RefreshCw, WifiOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { InlineNotice, InlineNoticeText } from "@/components/ui/inline-notice";
import type { ConnectivityState } from "@/lib/config/connectivity";

function messageFor(
  kind: Exclude<ConnectivityState["kind"], "online">,
  appName: string,
): { title: string; detail: string } {
  switch (kind) {
    case "browser-offline":
      return {
        title: "You're offline.",
        detail: "Reconnect to the internet, then retry.",
      };
    case "backend-unreachable":
      return {
        title: `Can't reach the ${appName} server.`,
        detail:
          "Check your connection. If it persists, ask an administrator to check the service.",
      };
    case "database-unavailable":
      return {
        title: "Database unavailable.",
        detail:
          "Ask an administrator to check the database service, connection settings, and capacity.",
      };
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
  const { title, detail } = messageFor(state.kind, appName);

  return (
    <InlineNotice data-testid={E2eTestId.ConnectivityStatusBar}>
      {state.kind === "database-unavailable" ? <AlertTriangle /> : <WifiOff />}
      <span className="font-medium">{title}</span>
      <InlineNoticeText>{detail}</InlineNoticeText>
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
