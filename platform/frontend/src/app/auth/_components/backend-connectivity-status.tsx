"use client";

import {
  AlertCircle,
  CheckCircle2,
  ExternalLink,
  Loader2,
  RefreshCcw,
  ServerOff,
} from "lucide-react";
import { useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
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
 * - Shows "Connected" message briefly after recovering from connection issues
 * - Redirects authenticated users to their intended destination
 */
export function BackendConnectivityStatus({
  children,
}: BackendConnectivityStatusProps) {
  const { status, attemptCount, estimatedTotalAttempts, retry } =
    useBackendConnectivity();
  const searchParams = useSearchParams();
  const redirectTo = searchParams.get("redirectTo");
  const [showConnectedMessage, setShowConnectedMessage] = useState(false);
  const hadConnectionIssuesRef = useRef(false);
  const hasInitiatedRefreshRef = useRef(false);

  // Track if we had connection issues (were in "connecting" state with attempts)
  useEffect(() => {
    if (status === "connecting" && attemptCount > 0) {
      hadConnectionIssuesRef.current = true;
    }
  }, [status, attemptCount]);

  // When connected after having connection issues, show the connected message
  // and refresh the page if there's a redirectTo param
  useEffect(() => {
    if (status === "connected" && hadConnectionIssuesRef.current) {
      setShowConnectedMessage(true);

      // If there's a redirectTo param, refresh the page after showing the message
      // The normal auth flow will handle the redirect
      if (redirectTo && !hasInitiatedRefreshRef.current) {
        hasInitiatedRefreshRef.current = true;
        setTimeout(() => {
          window.location.reload();
        }, 1000);
      } else if (!redirectTo) {
        // No redirectTo, just show connected message briefly then show children
        const timer = setTimeout(() => {
          setShowConnectedMessage(false);
          hadConnectionIssuesRef.current = false;
        }, 1500);
        return () => clearTimeout(timer);
      }
    }
  }, [status, redirectTo]);

  // During "initializing" or "checking" (first health check in progress),
  // don't show any UI to avoid flashing the connecting dialog when backend is up
  if (status === "initializing" || status === "checking") {
    return null;
  }

  // Show "Connected" message briefly after recovering from connection issues
  if (status === "connected" && showConnectedMessage) {
    return <ConnectedSuccessView hasRedirectTo={!!redirectTo} />;
  }

  // When connected, render children (the login form)
  if (status === "connected") {
    return <>{children}</>;
  }

  // Show unified connection status view
  return (
    <ConnectionStatusView
      status={status}
      attemptCount={attemptCount}
      estimatedTotalAttempts={estimatedTotalAttempts}
      retry={retry}
    />
  );
}

function ConnectedSuccessView({ hasRedirectTo }: { hasRedirectTo: boolean }) {
  return (
    <main className="h-full flex items-center justify-center p-4">
      <Card className="max-w-md w-full">
        <CardHeader className="text-center">
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-green-100 dark:bg-green-900/30">
            <CheckCircle2 className="h-6 w-6 text-green-600 dark:text-green-400" />
          </div>
          <CardTitle className="text-green-600 dark:text-green-400">
            Connected
          </CardTitle>
          <CardDescription>
            {hasRedirectTo
              ? "Refreshing..."
              : "Successfully connected to the backend server."}
          </CardDescription>
        </CardHeader>
      </Card>
    </main>
  );
}

function ConnectionStatusView({
  status,
  attemptCount,
  estimatedTotalAttempts,
  retry,
}: {
  status: "connecting" | "unreachable";
  attemptCount: number;
  estimatedTotalAttempts: number;
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
                  Still trying to connect, attempt {attemptCount} /{" "}
                  {estimatedTotalAttempts}...
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
