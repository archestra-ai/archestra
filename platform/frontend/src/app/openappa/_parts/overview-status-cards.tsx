"use client";

import {
  ArrowRight,
  CircleCheck,
  CircleDashed,
  CircleX,
  ClipboardCheck,
  Github,
  LoaderCircle,
  RefreshCw,
} from "lucide-react";
import Link from "next/link";
import { type ReactNode, useState } from "react";
import { OpenAppaAlertIcon } from "@/components/openappa-icon";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { InlineNotice } from "@/components/ui/inline-notice";
import { Skeleton } from "@/components/ui/skeleton";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { useAppName } from "@/lib/hooks/use-app-name";
import {
  useAppaGithubSync,
  useUpdateAppaGithubSync,
} from "@/lib/openappa-github-sync.query";
import { useOpenAppaPolicyTestRuns } from "@/lib/openappa-policy-tests.query";
import { useOpenAppaYellsSummary } from "@/lib/openappa-yells.query";
import { formatDate, formatRelativeTimeFromNow } from "@/lib/utils/date-time";
import { cn } from "@/lib/utils/tailwind";
import { ValidationStatusBadge } from "../validation/_parts/validation-parts";
import { GithubSyncSetupDialog } from "./github-sync-setup-dialog";

/** Where the policy syncs from, the latest validation run, and the unresolved yells. */
export function OverviewStatusCards() {
  const { data: canReadSettings } = useHasPermissions({
    organizationSettings: ["read"],
  });
  const { data: canReadPolicy } = useHasPermissions({
    openappaPolicy: ["read"],
  });
  const { data: canReadYells } = useHasPermissions({
    openappaDiagnostics: ["read"],
  });
  if (!canReadSettings && !canReadPolicy && !canReadYells) return null;
  return (
    <section aria-labelledby="overview-policy-health" className="space-y-3">
      <div className="space-y-1">
        <h2 id="overview-policy-health" className="text-base font-semibold">
          Policy health
        </h2>
        <p className="text-sm text-muted-foreground">
          Where your policy syncs from, how its validations ran, and what agents
          reported.
        </p>
      </div>
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {canReadSettings && <GithubSyncCard />}
        {canReadPolicy && <ValidationCard />}
        {canReadYells && <YellsCard />}
      </div>
    </section>
  );
}

// =============================================================================
// Internal components
// =============================================================================

function GithubSyncCard() {
  const sync = useAppaGithubSync();
  const update = useUpdateAppaGithubSync();
  const { data: canManage } = useHasPermissions({
    organizationSettings: ["update"],
  });
  const appName = useAppName();
  const [creating, setCreating] = useState(false);
  const source = sync.data?.source ?? null;
  const connected = Boolean(source?.interval);
  const failed = source?.lastSyncError;
  return (
    <>
      <StatusCard
        icon={<Github />}
        title="GitHub sync"
        status={
          !sync.data ? null : failed ? (
            <Status failed>Sync failed</Status>
          ) : connected && source?.setupPullRequestNumber ? (
            <Badge variant="outline">
              <LoaderCircle className="animate-spin text-muted-foreground" />
              <span>Awaiting initial merge</span>
            </Badge>
          ) : connected ? (
            <Status done>Connected</Status>
          ) : !sync.data.enabled ? (
            <Status>Not available</Status>
          ) : (
            <Status>Not connected</Status>
          )
        }
        description={
          connected && source?.setupPullRequestNumber ? (
            <span>
              Merge the initial policy pull request to finish setup. Your
              current policy stays active until it merges.{" "}
              <span aria-live="polite">
                {source.lastSyncedAt
                  ? `Last checked ${formatRelativeTimeFromNow(source.lastSyncedAt).toLowerCase()}.`
                  : "Checking for the merge…"}
              </span>
            </span>
          ) : connected && source?.repo ? (
            <span>
              {appName} pulls the policy from{" "}
              <span className="font-mono text-foreground">{source.repo}</span>.
              Every change is a reviewed pull request.
            </span>
          ) : sync.data && !sync.data.enabled ? (
            "GitHub sync is turned off on this server."
          ) : (
            "Keep your guardrail policy in a repository, so every change is a reviewed pull request."
          )
        }
        action={
          !sync.data?.enabled ? null : connected &&
            source?.setupPullRequestNumber ? (
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" variant="outline" asChild>
                <a
                  href={`https://github.com/${source.repo}/pull/${source.setupPullRequestNumber}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  <span>Review and merge PR</span>
                  <ArrowRight />
                </a>
              </Button>
              {canManage && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={update.isPending}
                  onClick={() => update.mutate({ action: "sync" })}
                >
                  <RefreshCw
                    className={cn(update.isPending && "animate-spin")}
                  />
                  <span>
                    {update.isPending ? "Checking…" : "Check if merged"}
                  </span>
                </Button>
              )}
            </div>
          ) : !canManage ? (
            connected ? null : (
              <p className="text-sm text-muted-foreground">
                Ask an administrator to connect a repository.
              </p>
            )
          ) : connected || failed ? (
            <Button size="sm" variant="outline" asChild>
              <Link href="/settings/guardrails">
                <span>Sync settings</span>
                <ArrowRight />
              </Link>
            </Button>
          ) : (
            <Button
              size="sm"
              variant="outline"
              onClick={() => setCreating(true)}
            >
              <Github />
              <span>Create repository</span>
            </Button>
          )
        }
      />
      {creating && <GithubSyncSetupDialog onOpenChange={setCreating} />}
    </>
  );
}

function ValidationCard() {
  const history = useOpenAppaPolicyTestRuns(true);
  const run = history.data?.[0];
  const status = run
    ? run.executionError || !run.validation.valid || !run.files.length
      ? "cannot_run"
      : run.files.some((file) => file.status === "failed")
        ? "failed"
        : run.files.some((file) => file.status === "cannot_run")
          ? "cannot_run"
          : "passed"
    : null;
  const statusLabel = status
    ? { passed: "Passed", failed: "Failed", cannot_run: "Cannot run" }[status]
    : "";
  const qualifiers = [run?.draft && "draft", run?.stale && "outdated"].filter(
    Boolean,
  );
  const validationNoun = run?.files.length === 1 ? "validation" : "validations";
  return (
    <StatusCard
      icon={<ClipboardCheck />}
      title="Validations"
      status={
        !history.isError && status ? (
          <ValidationStatusBadge status={status}>
            <span>{`${statusLabel}${qualifiers.length ? ` (${qualifiers.join(", ")})` : ""}`}</span>
          </ValidationStatusBadge>
        ) : undefined
      }
      action={
        <Button size="sm" variant="outline" asChild>
          <Link href="/openappa/validation">
            <span>View Validations</span>
            <ArrowRight />
          </Link>
        </Button>
      }
    >
      {history.isError ? (
        <InlineNotice variant="error">
          <CircleX />
          <span className="font-medium">Could not load validation</span>
          <Button size="xs" variant="outline" onClick={() => history.refetch()}>
            <span>Retry</span>
          </Button>
        </InlineNotice>
      ) : history.isPending ? (
        <Skeleton className="h-12 w-full" />
      ) : run ? (
        <section
          className="space-y-3"
          aria-label="Last validation run"
          aria-live="polite"
        >
          <CardDescription className="leading-relaxed">
            {`Last run executed on ${formatDate({ date: run.createdAt })}.`}
          </CardDescription>
          <p className="flex items-baseline gap-2">
            <span className="text-3xl font-semibold tabular-nums">
              {run.files.length}
            </span>
            <span className="text-sm text-muted-foreground">
              {`${validationNoun} in this run`}
            </span>
          </p>
        </section>
      ) : (
        <p className="text-sm text-muted-foreground">No runs yet.</p>
      )}
    </StatusCard>
  );
}

function YellsCard() {
  const summary = useOpenAppaYellsSummary();
  return (
    <StatusCard
      icon={
        <span className="w-6">
          <OpenAppaAlertIcon animated className="w-full overflow-visible" />
        </span>
      }
      title="Yells"
      description="Agent reports of blocks it could not make sense of or get past. Investigate them with the configuration agent."
      action={
        <Button size="sm" variant="outline" asChild>
          <Link href="/openappa/yells">
            Review yells <ArrowRight />
          </Link>
        </Button>
      }
    >
      {summary.isError ? (
        <Button variant="ghost" size="sm" onClick={() => summary.refetch()}>
          Could not load yells. Retry
        </Button>
      ) : (
        <p className="flex items-baseline gap-2">
          <span className="text-3xl font-semibold tabular-nums">
            {summary.data?.unresolved ?? "—"}
          </span>
          <span className="text-sm text-muted-foreground">unresolved</span>
        </p>
      )}
    </StatusCard>
  );
}

function StatusCard({
  icon,
  title,
  status,
  description,
  children,
  action,
}: {
  icon: ReactNode;
  title: string;
  status?: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  action: ReactNode;
}) {
  return (
    <Card className="gap-3 py-4">
      <CardHeader className="flex items-center gap-3 px-4">
        <CardIcon>{icon}</CardIcon>
        <CardTitle className="flex-1 text-sm whitespace-nowrap">
          {title}
        </CardTitle>
        {status}
      </CardHeader>
      <CardContent className="flex-1 px-4 space-y-3">
        {description && (
          <CardDescription className="leading-relaxed">
            {description}
          </CardDescription>
        )}
        {children}
      </CardContent>
      <CardFooter className="px-4">{action}</CardFooter>
    </Card>
  );
}

function CardIcon({ children }: { children: ReactNode }) {
  return (
    <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary [&>svg]:size-4">
      {children}
    </span>
  );
}

function Status({
  done,
  failed,
  children,
}: {
  done?: boolean;
  failed?: boolean;
  children: string;
}) {
  return (
    <Badge variant={failed ? "destructive" : "outline"}>
      {failed ? (
        <CircleX />
      ) : done ? (
        <CircleCheck className="text-emerald-600 dark:text-emerald-400" />
      ) : (
        <CircleDashed className="text-muted-foreground" />
      )}
      <span>{children}</span>
    </Badge>
  );
}
