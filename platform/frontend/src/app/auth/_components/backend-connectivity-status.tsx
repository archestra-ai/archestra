"use client";

import { GITHUB_REPO_URL } from "@archestra/shared";
import { Check, ExternalLink, RefreshCcw, ServerOff } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { AppLogo } from "@/components/app-logo";
import { Button } from "@/components/ui/button";
import { useBackendConnectivity } from "@/lib/config/backend-connectivity";
import { useAppName } from "@/lib/hooks/use-app-name";

interface BackendConnectivityStatusProps {
  children: React.ReactNode;
}

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
        indicator={<Check className="size-6" strokeWidth={2} />}
        indicatorClassName="text-emerald-600 dark:text-emerald-400"
        title="Connection restored"
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
      attemptCount={attemptCount}
      estimatedTotalAttempts={estimatedTotalAttempts}
      onRetry={retry}
    />
  );
}

function ConnectionStatusView({
  status,
  attemptCount,
  estimatedTotalAttempts,
  onRetry,
}: {
  status: "connecting" | "unreachable";
  attemptCount: number;
  estimatedTotalAttempts: number;
  onRetry: () => void;
}) {
  const appName = useAppName();
  const isUnreachable = status === "unreachable";

  return (
    <ConnectivityView
      indicator={
        isUnreachable ? (
          <ServerOff className="size-6" strokeWidth={1.75} />
        ) : (
          <ConnectionSignal />
        )
      }
      indicatorClassName={isUnreachable ? "text-destructive" : undefined}
      title={isUnreachable ? "Backend unavailable" : `Waiting for ${appName}`}
      description={
        isUnreachable
          ? `The ${appName} backend did not respond. Check that it is running, then try again.`
          : `The ${appName} backend is still starting. This page will continue automatically.`
      }
      detail={
        !isUnreachable && attemptCount > 0
          ? `Attempt ${attemptCount} of ${estimatedTotalAttempts}`
          : undefined
      }
      urgent={isUnreachable}
      actions={
        isUnreachable ? (
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
        ) : undefined
      }
    />
  );
}

function ConnectivityView({
  indicator,
  indicatorClassName,
  title,
  description,
  detail,
  actions,
  urgent = false,
}: {
  indicator: React.ReactNode;
  indicatorClassName?: string;
  title: string;
  description: string;
  detail?: string;
  actions?: React.ReactNode;
  urgent?: boolean;
}) {
  return (
    <main className="flex min-h-full items-center justify-center px-6 py-12">
      <section
        className="w-full max-w-sm text-center"
        role={urgent ? "alert" : "status"}
      >
        <AppLogo />

        <div
          className={`mx-auto mt-10 flex size-10 items-center justify-center text-muted-foreground ${indicatorClassName ?? ""}`}
          aria-hidden="true"
        >
          {indicator}
        </div>

        <h1 className="mt-5 text-xl font-semibold tracking-tight">{title}</h1>
        <p className="mx-auto mt-2 max-w-xs text-sm leading-6 text-muted-foreground">
          {description}
        </p>

        {detail && (
          <p className="mt-4 font-mono text-[11px] tracking-wide text-muted-foreground/80">
            {detail}
          </p>
        )}

        {actions && (
          <div className="mt-7 flex items-center justify-center gap-2">
            {actions}
          </div>
        )}
      </section>
    </main>
  );
}

function ConnectionSignal() {
  return (
    <span className="relative flex size-3 items-center justify-center">
      <span className="absolute size-3 animate-ping rounded-full bg-primary/35 motion-reduce:animate-none" />
      <span className="relative size-2 rounded-full bg-primary" />
    </span>
  );
}
