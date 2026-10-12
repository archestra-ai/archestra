"use client";

import {
  ArrowRight,
  CircleCheck,
  CircleDashed,
  CircleX,
  ClipboardCheck,
  MessageCircle,
  Settings,
  ShieldCheck,
} from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { ExternalDocsLink } from "@/components/external-docs-link";
import { OpenAppaAlertIcon } from "@/components/openappa-icon";
import { OpenAppaMascot } from "@/components/openappa-mascot";
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
import { cn } from "@/lib/utils/tailwind";
import { ValidationStatusBadge } from "../validation/_parts/validation-parts";
import { GithubManagedPolicyNotice } from "./github-managed-policy-notice";
import { OpenAppaChatButton } from "./openappa-chat-button";
import { useOpenAppaSetupState } from "./use-openappa-setup-state";

/**
 * Where OpenAPPA setup stands. A fresh organization sees only the first step,
 * saving a policy in the policy chat (which turns enforcement on). After that,
 * compact cards report enforcement, validation, and unresolved yells.
 * The first unfinished one is highlighted as the next step.
 */
export function OverviewSetupCards() {
  const { enabled, isFresh } = useOpenAppaSetupState();
  const sync = useAppaGithubSync();
  const { data: canReadYells } = useHasPermissions({
    openappaDiagnostics: ["read"],
  });
  const { data: canReadSettings } = useHasPermissions({
    organizationSettings: ["read"],
  });
  const { data: canReadPolicy } = useHasPermissions({
    openappaPolicy: ["read"],
  });
  if (isFresh === undefined) return null;
  if (isFresh) return <PolicyStep />;
  const source = sync.data?.source;
  const next = !enabled ? "enforcement" : null;
  const cardCount =
    Number(Boolean(canReadSettings)) +
    Number(Boolean(canReadPolicy)) +
    Number(Boolean(canReadYells));
  return (
    <div className="space-y-4">
      {(source?.lastSyncError || source?.setupPullRequestNumber) && (
        <GithubManagedPolicyNotice />
      )}
      <div
        className={cn(
          "grid gap-4",
          cardCount > 1 && "md:grid-cols-2",
          cardCount === 4
            ? "2xl:grid-cols-4"
            : cardCount === 3
              ? "xl:grid-cols-3"
              : undefined,
        )}
      >
        {canReadSettings && <EnforcementCard next={next === "enforcement"} />}
        {canReadPolicy && <ValidationCard />}
        {canReadYells && <YellsCard />}
      </div>
    </div>
  );
}

/**
 * The whole page for an organization that has not saved a policy yet. There is
 * one thing to do here, so the page is that one thing: the mascot, what the
 * guardrail is for, and the button.
 */
function PolicyStep() {
  const { data: canEdit } = useHasPermissions({ openappaPolicy: ["update"] });
  return (
    <section className="mx-auto flex max-w-xl flex-col items-center px-2 py-10 text-center sm:py-16">
      {/* A flat disc rather than a blurred glow: the mark is pixel art with
          hard edges, and a soft halo behind it reads as a smudge on the page
          rather than as a deliberate ground. */}
      <span className="flex size-40 items-center justify-center rounded-full bg-muted sm:size-52">
        <OpenAppaMascot className="size-24 sm:size-32" />
      </span>
      <h2 className="mt-8 text-2xl font-semibold tracking-tight text-balance sm:text-3xl">
        Turn on the guardrail
      </h2>
      <p className="mt-3 leading-relaxed text-pretty text-muted-foreground">
        OpenAPPA is a frontier deterministic guardrail. It tracks where data
        came from and who may see it, rather than asking a second model to
        judge, which makes it 100% resistant to data exfiltration from prompt
        injection or model hallucination.
      </p>
      <div className="mt-8 flex flex-wrap items-center justify-center gap-x-6 gap-y-3">
        {canEdit ? (
          <OpenAppaChatButton promptKey="setUpPolicy">
            <MessageCircle />
            <span>Create my policy</span>
          </OpenAppaChatButton>
        ) : (
          <p className="text-sm text-muted-foreground">
            Ask an administrator to turn on the guardrail.
          </p>
        )}
        <ExternalDocsLink
          href={openAppaUrl("/how-it-works")}
          className="text-sm"
        >
          How OpenAPPA works
        </ExternalDocsLink>
      </div>
    </section>
  );
}

function EnforcementCard({ next }: { next: boolean }) {
  const { enabled } = useOpenAppaSetupState();
  const { data: canManage } = useHasPermissions({
    organizationSettings: ["update"],
  });
  return (
    <StatusCard
      next={next}
      icon={<ShieldCheck />}
      title="Enforcement"
      status={enabled ? <Status done>On</Status> : <Status>Off</Status>}
      description={
        <span>
          <span>
            {enabled
              ? "Guardrails are on. Every tool call is checked against your policy before it runs."
              : "Guardrails are off. Your policy isn't applied, so agents can call any tool."}
          </span>
          {!canManage && (
            <span> Only administrators can change enforcement settings.</span>
          )}
        </span>
      }
      action={
        <div className="flex w-full flex-wrap items-center justify-between gap-2">
          {canManage && (
            <Button size="sm" variant="outline" asChild>
              <Link href="/settings/guardrails#enforcement">
                <Settings />
                <span>Settings</span>
              </Link>
            </Button>
          )}
          <OpenAppaChatButton size="sm" variant="outline">
            <MessageCircle />
            <span>Ask about the policy</span>
          </OpenAppaChatButton>
        </div>
      }
    />
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
  next,
  icon,
  title,
  status,
  description,
  children,
  learnMore,
  action,
}: {
  next?: boolean;
  icon: ReactNode;
  title: string;
  status?: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  learnMore?: { href: string; label: string };
  action: ReactNode;
}) {
  return (
    <Card
      className={cn("gap-3 py-4", next && "border-primary")}
      data-next-step={next || undefined}
    >
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
      {(action || learnMore) && (
        <CardFooter className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4">
          {action}
          {learnMore && (
            <ExternalDocsLink
              href={learnMore.href}
              className="shrink-0 text-xs text-muted-foreground"
            >
              {learnMore.label}
            </ExternalDocsLink>
          )}
        </CardFooter>
      )}
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

/** A page of the OpenAPPA site, where the concepts behind a card are explained. */
export function openAppaUrl(path: string): string {
  return `https://www.openappa.com${path}`;
}
