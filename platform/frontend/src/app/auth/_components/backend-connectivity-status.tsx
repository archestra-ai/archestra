"use client";

import { GITHUB_REPO_URL } from "@archestra/shared";
import { ExternalLink, RefreshCcw } from "lucide-react";
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
import { Skeleton } from "@/components/ui/skeleton";
import { useBackendConnectivity } from "@/lib/config/backend-connectivity";
import { useAppName } from "@/lib/hooks/use-app-name";

interface BackendConnectivityStatusProps {
  children: React.ReactNode;
}

export function BackendConnectivityStatus({
  children,
}: BackendConnectivityStatusProps) {
  const { status, attemptCount, retry } = useBackendConnectivity();
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

  return <ConnectionStatusView status={status} onRetry={retry} />;
}

function ConnectionStatusView({
  status,
  onRetry,
}: {
  status: "connecting" | "unreachable";
  onRetry: () => void;
}) {
  const appName = useAppName();
  const isUnreachable = status === "unreachable";

  if (!isUnreachable) {
    return (
      <ConnectivityView
        title={`Starting ${appName}`}
        description="Finishing startup. Sign-in will appear automatically."
        busy
      >
        <SignInSkeleton />
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

function SignInSkeleton() {
  return (
    <CardContent className="space-y-5" aria-hidden="true">
      <div className="space-y-2">
        <Skeleton className="h-3 w-12 bg-muted-foreground/15 motion-reduce:animate-none" />
        <Skeleton className="h-9 w-full bg-muted-foreground/15 motion-reduce:animate-none" />
      </div>
      <div className="space-y-2">
        <Skeleton className="h-3 w-16 bg-muted-foreground/15 motion-reduce:animate-none" />
        <Skeleton className="h-9 w-full bg-muted-foreground/15 motion-reduce:animate-none" />
      </div>
      <Skeleton className="h-9 w-full bg-muted-foreground/15 motion-reduce:animate-none" />
    </CardContent>
  );
}
