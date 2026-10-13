"use client";

import {
  ArrowRight,
  CircleCheck,
  CircleX,
  ClipboardCheck,
  GitBranch,
} from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
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
import { useAppaGithubSync } from "@/lib/openappa-github-sync.query";
import { useOpenAppaPolicyTestRuns } from "@/lib/openappa-policy-tests.query";
import { useOpenAppaYellsSummary } from "@/lib/openappa-yells.query";
import { formatDate } from "@/lib/utils/date-time";
import { ValidationStatusBadge } from "../validation/_parts/validation-parts";

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
    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
      {canReadSettings && <SyncCard />}
      {canReadPolicy && <ValidationCard />}
      {canReadYells && <YellsCard />}
    </div>
  );
}

// =============================================================================
// Internal components
// =============================================================================

function SyncCard() {
  const sync = useAppaGithubSync();
  const source = sync.data?.source;
  const connected = Boolean(source?.repo);
  return (
    <StatusCard
      icon={<GitBranch />}
      title="Git sync"
      status={
        source?.lastSyncError ? (
          <Badge variant="destructive">
            <CircleX />
            <span>Failed</span>
          </Badge>
        ) : source?.setupPullRequestNumber ? (
          <Badge variant="outline">
            <span>Waiting for merge</span>
          </Badge>
        ) : connected ? (
          <Badge variant="outline">
            <CircleCheck className="text-emerald-600 dark:text-emerald-400" />
            <span>Synced</span>
          </Badge>
        ) : undefined
      }
      action={
        <Button size="sm" variant="outline" asChild>
          <Link href="/settings/guardrails">
            <span>{connected ? "Sync settings" : "Set up sync"}</span>
            <ArrowRight />
          </Link>
        </Button>
      }
    >
      {sync.isError ? (
        <Button variant="ghost" size="sm" onClick={() => sync.refetch()}>
          Could not load sync. Retry
        </Button>
      ) : sync.isPending ? (
        <Skeleton className="h-12 w-full" />
      ) : connected && source ? (
        <div className="space-y-1.5">
          <p className="truncate font-mono text-sm">{`${source.repo} · ${source.ref ?? "HEAD"}`}</p>
          <CardDescription>
            {source.lastSyncedAt
              ? `Last synced ${formatDate({ date: source.lastSyncedAt })}.`
              : "Not synced yet."}
          </CardDescription>
        </div>
      ) : (
        <CardDescription className="leading-relaxed">
          Keep your policy in a repository and review every change as a pull
          request.
        </CardDescription>
      )}
    </StatusCard>
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
