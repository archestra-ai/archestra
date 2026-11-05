"use client";

import { E2eTestId } from "@archestra/shared";
import { AlertTriangle, RefreshCw, WifiOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  InlineNotice,
  InlineNoticeBody,
  InlineNoticeText,
} from "@/components/ui/inline-notice";
import type { ConnectivityState } from "@/lib/config/connectivity";
import { getConnectivityMessage } from "@/lib/config/connectivity-messages";

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
  const { title, detail } = getConnectivityMessage(state.kind, appName);

  return (
    <InlineNotice data-testid={E2eTestId.ConnectivityStatusBar}>
      {state.kind === "database-unavailable" ? <AlertTriangle /> : <WifiOff />}
      {/* The detail is a full sentence, so it sits under the title rather
          than squeezing beside it into a narrow column on a phone. */}
      <InlineNoticeBody>
        <span className="font-medium">{title}</span>
        <InlineNoticeText>{detail}</InlineNoticeText>
      </InlineNoticeBody>
      {/* Icon-only below `sm`, where the label would take the message's width. */}
      <Button
        size="sm"
        variant="outline"
        className="ml-auto shrink-0 max-sm:size-8 max-sm:px-0"
        aria-label="Retry"
        data-testid={E2eTestId.ConnectivityStatusBarRetry}
        onClick={onRetry}
      >
        <RefreshCw className="h-4 w-4" />
        <span className="max-sm:sr-only">Retry</span>
      </Button>
    </InlineNotice>
  );
}
