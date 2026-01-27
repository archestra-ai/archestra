"use client";

import { AlertCircle, Loader2, RefreshCcw, ServerOff } from "lucide-react";
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
  const { status, attemptCount, elapsedMs, retry } = useBackendConnectivity();

  // When connected, render children (the login form)
  if (status === "connected") {
    return <>{children}</>;
  }

  // When still connecting, show the connecting state
  if (status === "connecting") {
    return <ConnectingView attemptCount={attemptCount} elapsedMs={elapsedMs} />;
  }

  // When unreachable, show the error state
  return <UnreachableView retry={retry} />;
}

function ConnectingView({
  attemptCount,
  elapsedMs,
}: {
  attemptCount: number;
  elapsedMs: number;
}) {
  const elapsedSeconds = Math.floor(elapsedMs / 1000);

  return (
    <main className="h-full flex items-center justify-center p-4">
      <Card className="max-w-md w-full">
        <CardHeader className="text-center">
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-muted">
            <Loader2 className="h-6 w-6 text-muted-foreground animate-spin" />
          </div>
          <CardTitle>Connecting to Server</CardTitle>
          <CardDescription>
            Please wait while we establish a connection to the backend server.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-center gap-2 text-sm text-muted-foreground">
            <span>Attempting to connect...</span>
          </div>
          {attemptCount > 0 && (
            <Alert className="border-amber-200 bg-amber-50 dark:border-amber-900 dark:bg-amber-950">
              <AlertCircle className="h-4 w-4 text-amber-600 dark:text-amber-400" />
              <AlertDescription className="text-amber-700 dark:text-amber-300 text-sm">
                Still trying to connect (attempt {attemptCount})...
                {elapsedSeconds > 0 && ` (${elapsedSeconds}s elapsed)`}
              </AlertDescription>
            </Alert>
          )}
        </CardContent>
      </Card>
    </main>
  );
}

function UnreachableView({ retry }: { retry: () => void }) {
  return (
    <main className="h-full flex items-center justify-center p-4">
      <Card className="max-w-md w-full">
        <CardHeader className="text-center">
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-destructive/10">
            <ServerOff className="h-6 w-6 text-destructive" />
          </div>
          <CardTitle>Unable to Connect</CardTitle>
          <CardDescription>
            We couldn't establish a connection to the backend server after
            multiple attempts.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Alert className="border-destructive/50 bg-destructive/10">
            <AlertCircle className="h-4 w-4 text-destructive" />
            <AlertTitle className="text-destructive">
              Server Unreachable
            </AlertTitle>
            <AlertDescription className="text-destructive/90">
              <p className="text-sm mb-3">
                The backend server is not responding. This could be due to:
              </p>
              <ul className="list-disc list-inside space-y-1 text-sm">
                <li>The server is still starting up</li>
                <li>Network connectivity issues</li>
                <li>The server is experiencing problems</li>
              </ul>
            </AlertDescription>
          </Alert>
          <div className="flex justify-center pt-2">
            <Button onClick={retry} variant="outline" className="gap-2">
              <RefreshCcw className="h-4 w-4" />
              Try Again
            </Button>
          </div>
          <p className="text-xs text-muted-foreground text-center">
            If this problem persists, please check your server logs or contact
            your administrator.
          </p>
        </CardContent>
      </Card>
    </main>
  );
}
