"use client";

import { GITHUB_REPO_URL } from "@archestra/shared";
import { ExternalLink, LoaderCircle, RefreshCcw } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { AppLogo } from "@/components/app-logo";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { useBackendConnectivity } from "@/lib/config/backend-connectivity";
import { useAppName } from "@/lib/hooks/use-app-name";

interface BackendConnectivityStatusProps {
  children: React.ReactNode;
}

export function BackendConnectivityStatus({
  children,
}: BackendConnectivityStatusProps) {
  const { status, attemptCount, nextRetryInMs, retry } =
    useBackendConnectivity();
  const searchParams = useSearchParams();
  const redirectTo = searchParams.get("redirectTo");
  const [showConnectedMessage, setShowConnectedMessage] = useState(false);
  const hadConnectionIssuesRef = useRef(false);
  const hasInitiatedRefreshRef = useRef(false);

  useEffect(() => {
    if (status === "connecting" && attemptCount > 0) {
      hadConnectionIssuesRef.current = true;
    }
  }, [status, attemptCount]);

  useEffect(() => {
    if (status !== "connected" || !hadConnectionIssuesRef.current) {
      return;
    }

    setShowConnectedMessage(true);

    if (redirectTo && !hasInitiatedRefreshRef.current) {
      hasInitiatedRefreshRef.current = true;
      setTimeout(() => {
        window.location.reload();
      }, 1000);
      return;
    }

    const timer = setTimeout(() => {
      setShowConnectedMessage(false);
      hadConnectionIssuesRef.current = false;
    }, 1500);

    return () => clearTimeout(timer);
  }, [status, redirectTo]);

  if (status === "initializing" || status === "checking") {
    return null;
  }

  if (status === "connected" && showConnectedMessage) {
    return (
      <ConnectivityView
        title="Ready"
        description={
          redirectTo ? "Reloading the page." : "Continuing to sign in."
        }
      />
    );
  }

  if (status === "connected") {
    return <>{children}</>;
  }

  return (
    <ConnectionStatusView
      status={status}
      nextRetryInMs={nextRetryInMs}
      onRetry={retry}
    />
  );
}

function ConnectionStatusView({
  status,
  nextRetryInMs,
  onRetry,
}: {
  status: "connecting" | "unreachable";
  nextRetryInMs: number | null;
  onRetry: () => void;
}) {
  const appName = useAppName();
  const isUnreachable = status === "unreachable";

  if (!isUnreachable) {
    return (
      <ConnectivityView
        title={`Connecting to ${appName}`}
        description="The backend is not responding yet. Sign-in will appear when it is ready."
        busy
      >
        <ConnectionActivity nextRetryInMs={nextRetryInMs} />
      </ConnectivityView>
    );
  }

  return (
    <ConnectivityView
      title="Backend unavailable"
      description={`The ${appName} backend did not respond. Check that it is running, then try again.`}
      urgent
      actions={
        <>
          <Button type="button" onClick={onRetry}>
            <RefreshCcw className="size-4" />
            <span>Try again</span>
          </Button>
          <Button variant="ghost" asChild>
            <a
              href={`${GITHUB_REPO_URL}/issues`}
              target="_blank"
              rel="noreferrer noopener"
            >
              <span>Report issue</span>
              <ExternalLink className="size-3.5" />
            </a>
          </Button>
        </>
      }
    />
  );
}

function ConnectivityView({
  title,
  description,
  actions,
  children,
  busy = false,
  urgent = false,
}: {
  title: string;
  description: string;
  actions?: React.ReactNode;
  children?: React.ReactNode;
  busy?: boolean;
  urgent?: boolean;
}) {
  return (
    <main className="h-full flex items-center justify-center p-4">
      <div className="space-y-4 w-full max-w-md">
        <AppLogo />

        <Card
          className={urgent ? "border-destructive/40" : undefined}
          role={urgent ? "alert" : "status"}
          aria-busy={busy || undefined}
        >
          <CardHeader>
            <CardTitle className="text-xl">
              <h1>{title}</h1>
            </CardTitle>
            <CardDescription>{description}</CardDescription>
          </CardHeader>

          {children}

          {actions && <CardFooter className="gap-2">{actions}</CardFooter>}
        </Card>
      </div>
    </main>
  );
}

function ConnectionActivity({
  nextRetryInMs,
}: {
  nextRetryInMs: number | null;
}) {
  const retryStatus =
    nextRetryInMs === null
      ? "Checking now"
      : `Next retry in ${Math.max(1, Math.ceil(nextRetryInMs / 1000))}s`;

  return (
    <CardContent>
      <div className="flex items-center gap-3 rounded-md border bg-muted/30 p-3">
        <LoaderCircle
          className="size-4 shrink-0 animate-spin text-primary motion-reduce:animate-none"
          aria-hidden="true"
        />
        <p className="min-w-0 flex-1 text-sm font-medium">
          Retrying automatically
        </p>
        <p
          className="shrink-0 text-xs tabular-nums text-muted-foreground"
          aria-live="polite"
        >
          <span>{retryStatus}</span>
        </p>
      </div>
    </CardContent>
  );
}
