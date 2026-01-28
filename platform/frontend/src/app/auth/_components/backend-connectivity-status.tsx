"use client";

import {
  AlertCircle,
  ExternalLink,
  Loader2,
  RefreshCcw,
  ServerOff,
} from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { useBackendConnectivity } from "@/lib/backend-connectivity";

interface BackendConnectivityStatusProps {
  /**
   * Children to render when the backend is connected
   */
  children: React.ReactNode;
}

/**
 * Wrapper component that shows connection status while trying to reach the backend.
 * - Shows a "Connecting..." message while attempting to connect
 * - Shows children only when connected
 * - Shows an error message after 1 minute of failed attempts
 */
export function BackendConnectivityStatus({
  children,
}: BackendConnectivityStatusProps) {
  const { status, attemptCount, retry } = useBackendConnectivity();

  // When connected, render children (the login form)
  if (status === "connected") {
    return <>{children}</>;
  }

  // Show unified connection status view
  return (
    <ConnectionStatusView
      status={status}
      attemptCount={attemptCount}
      retry={retry}
    />
  );
}

function ConnectionStatusView({
  status,
  attemptCount,
  retry,
}: {
  status: "connecting" | "unreachable";
  attemptCount: number;
  retry: () => void;
}) {
  const isUnreachable = status === "unreachable";

  return (
    <main className="h-full flex items-center justify-center p-4">
      <Card className="max-w-md w-full">
        <CardHeader className="text-center">
          <div
            className={`mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full ${
              isUnreachable ? "bg-destructive/10" : "bg-muted"
            }`}
          >
            {isUnreachable ? (
              <ServerOff className="h-6 w-6 text-destructive" />
            ) : (
              <Loader2 className="h-6 w-6 text-muted-foreground animate-spin" />
            )}
          </div>
          <CardTitle>
            {isUnreachable ? "Unable to Connect" : "Connecting..."}
          </CardTitle>
          <CardDescription>
            {isUnreachable
              ? "Unable to establish a connection to the backend server after multiple attempts."
              : "Establishing connection to the Archestra backend server."}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {isUnreachable ? (
            <Alert className="border-destructive/50 bg-destructive/10">
              <AlertCircle className="h-4 w-4 text-destructive" />
              <AlertTitle className="text-destructive">
                Server Unreachable
              </AlertTitle>
              <AlertDescription className="text-destructive/90">
                <p className="text-sm mb-3">
                  The backend server is not responding. Possible causes:
                </p>
                <ul className="list-disc list-inside space-y-1 text-sm">
                  <li>Server is still starting up</li>
                  <li>Network connectivity issue</li>
                  <li>Server configuration problem</li>
                </ul>
              </AlertDescription>
            </Alert>
          ) : (
            <>
              {attemptCount === 0 && (
                <div className="flex items-center justify-center gap-2 text-sm text-muted-foreground">
                  <span>Attempting to connect...</span>
                </div>
              )}
              {attemptCount > 0 && (
                <div className="flex items-center justify-center gap-2 text-sm text-muted-foreground">
                  Still trying to connect, attempt {attemptCount}...
                </div>
              )}
            </>
          )}

          <div className="flex justify-center gap-2">
            {isUnreachable && (
              <Button
                onClick={retry}
                variant="outline"
                size="sm"
                className="gap-2"
              >
                <RefreshCcw className="h-4 w-4" />
                Try Again
              </Button>
            )}
            {(attemptCount > 0 || isUnreachable) && (
              <Button
                variant="outline"
                size="sm"
                onClick={() =>
                  window.open(
                    "https://github.com/archestra-ai/archestra/issues",
                    "_blank",
                  )
                }
              >
                Report issue on GitHub
                <ExternalLink className="ml-1 h-3 w-3" />
              </Button>
            )}
          </div>
        </CardContent>
      </Card>
    </main>
  );
}
