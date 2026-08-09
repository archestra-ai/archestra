"use client";

import type { archestraApiTypes } from "@archestra/shared";
import { CheckCircle2, LinkIcon, TriangleAlert } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { useEffect, useRef } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useStartGoogleDriveOAuth } from "@/lib/knowledge/connector.query";

type Connector = archestraApiTypes.GetConnectorResponses["200"];

/**
 * The Google account a Drive connector in individual mode syncs as, and the
 * button to (re)authorize it.
 *
 * Shown on the connector's own page because the authorization outlives the
 * create dialog: a refresh token can be revoked from the Google side at any
 * time, and reconnecting has to be reachable long after setup.
 */
export function GoogleDriveConnectionCard({
  connector,
}: {
  connector: Connector;
}) {
  useGoogleDriveOAuthResultToast();

  const startOAuth = useStartGoogleDriveOAuth();
  const config = connector.config as
    | {
        type?: string;
        authMode?: string;
        connectedAccountEmail?: string;
      }
    | undefined;

  if (config?.type !== "gdrive" || config.authMode !== "oauth") return null;

  const connectedEmail = config.connectedAccountEmail;

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-4">
      <div className="flex items-center gap-3">
        {connectedEmail ? (
          <CheckCircle2 className="h-5 w-5 shrink-0 text-green-600" />
        ) : (
          <TriangleAlert className="h-5 w-5 shrink-0 text-amber-600" />
        )}
        <div className="text-sm">
          <div className="font-medium">
            {connectedEmail
              ? `Connected as ${connectedEmail}`
              : "No Google account connected"}
          </div>
          <div className="text-muted-foreground">
            {connectedEmail
              ? "This connector indexes what that account can see in Drive."
              : "This connector cannot sync until a Google account authorizes it."}
          </div>
        </div>
      </div>
      <Button
        variant={connectedEmail ? "outline" : "default"}
        size="sm"
        disabled={startOAuth.isPending}
        onClick={() => startOAuth.mutate({ connectorId: connector.id })}
      >
        <LinkIcon className="h-4 w-4" />
        {connectedEmail ? "Reconnect" : "Connect Google account"}
      </Button>
    </div>
  );
}

/**
 * Report the outcome of a return trip from Google.
 *
 * The callback redirects here with one of two markers rather than rendering
 * anything itself, so the person ends up back on the connector instead of
 * looking at an API response.
 */
function useGoogleDriveOAuthResultToast() {
  const searchParams = useSearchParams();
  const connected = searchParams.get("gdriveConnected");
  const failed = searchParams.get("gdriveOauthError");
  // A toast belongs to one arrival, and React may run this effect twice in
  // development; the marker stays in the URL either way.
  const reported = useRef<string | null>(null);

  useEffect(() => {
    const marker = connected ?? failed;
    if (!marker || reported.current === marker) return;
    reported.current = marker;

    if (connected) {
      toast.success(`Connected ${connected}. The first sync is starting.`);
    } else if (failed) {
      toast.error(failed);
    }
  }, [connected, failed]);
}
