"use client";

import {
  ArrowRight,
  BookOpen,
  CircleCheck,
  CircleDashed,
  CircleX,
  Github,
  MessageCircle,
  ShieldCheck,
} from "lucide-react";
import Link from "next/link";
import { type ReactNode, useState } from "react";
import { ExternalDocsLink } from "@/components/external-docs-link";
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
import { useHasPermissions } from "@/lib/auth/auth.query";
import { useAppName } from "@/lib/hooks/use-app-name";
import { useAppaGithubSync } from "@/lib/openappa-github-sync.query";
import { openAppaChatHref } from "@/lib/openappa-routes";
import { cn } from "@/lib/utils/tailwind";
import { OpenAppaSourceForm } from "./appa-github-sync-panel";
import { useOpenAppaSetupState } from "./use-openappa-setup-state";

/**
 * Where OpenAPPA setup stands. A fresh organization sees only the first step,
 * saving a policy in the policy chat (which turns enforcement on). After that,
 * three compact cards report enforcement and GitHub sync and link to the
 * docs, and the first unfinished one is highlighted as the next step.
 */
export function OverviewSetupCards() {
  const { enabled, isFresh } = useOpenAppaSetupState();
  const sync = useAppaGithubSync();
  if (isFresh === undefined) return null;
  if (isFresh) return <PolicyStep />;
  const source = sync.data?.source;
  const synced = Boolean(source?.interval && !source.lastSyncError);
  const next = !enabled
    ? "enforcement"
    : sync.data?.enabled && !synced
      ? "github"
      : null;
  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <EnforcementCard next={next === "enforcement"} />
      <GithubSyncCard next={next === "github"} />
      <LearnMoreCard />
    </div>
  );
}

function PolicyStep() {
  const { data: canEdit } = useHasPermissions({ toolPolicy: ["update"] });
  const appName = useAppName();
  return (
    <Card className="max-w-2xl gap-4 py-5">
      <CardHeader className="flex items-center gap-3 px-5">
        <CardIcon>
          <ShieldCheck />
        </CardIcon>
        <div className="flex-1">
          <p className="text-xs text-muted-foreground">Step 1 of 2</p>
          <CardTitle className="text-sm">Turn on the guardrail</CardTitle>
        </div>
      </CardHeader>
      <CardContent className="space-y-4 px-5">
        <CardDescription className="leading-relaxed">
          {appName}&apos;s guardrail uses OpenAPPA to control where your
          agents&apos; data can go.
        </CardDescription>
        <ol className="list-decimal space-y-1 border-t pt-4 pl-5 text-sm text-muted-foreground">
          <li>The policy chat looks at your tools and drafts a policy.</li>
          <li>You review it. Nothing changes until you approve.</li>
          <li>Approving turns the guardrail on.</li>
        </ol>
      </CardContent>
      <CardFooter className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-5">
        {canEdit ? (
          <Button size="sm" asChild>
            <Link href={openAppaChatHref({ promptKey: "setUpPolicy" })}>
              <MessageCircle />
              <span>Create my policy</span>
            </Link>
          </Button>
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
      </CardFooter>
    </Card>
  );
}

function EnforcementCard({ next }: { next: boolean }) {
  const { enabled } = useOpenAppaSetupState();
  const appName = useAppName();
  return (
    <StatusCard
      next={next}
      icon={<ShieldCheck />}
      title="Enforcement"
      status={enabled ? <Status done>On</Status> : <Status>Off</Status>}
      description={
        enabled
          ? `${appName} checks every tool call against your policy before it runs.`
          : "Tool calls run unchecked. Turn the guardrail on from the Policy tab."
      }
      action={
        enabled ? (
          <Button size="sm" variant="outline" asChild>
            <Link href={openAppaChatHref({ promptKey: "explainPolicy" })}>
              <MessageCircle />
              <span>Ask about the policy</span>
            </Link>
          </Button>
        ) : (
          <Button size="sm" variant={next ? "default" : "outline"} asChild>
            <Link href="/openappa/policy">
              <span>Open the policy</span>
              <ArrowRight />
            </Link>
          </Button>
        )
      }
    />
  );
}

function GithubSyncCard({ next }: { next: boolean }) {
  const sync = useAppaGithubSync();
  const { data: canManage } = useHasPermissions({ organization: ["update"] });
  const appName = useAppName();
  const [editing, setEditing] = useState(false);
  const source = sync.data?.source ?? null;
  const connected = Boolean(source?.interval);
  const failed = source?.lastSyncError;
  return (
    <>
      <StatusCard
        next={next}
        icon={<Github />}
        title="GitHub sync"
        status={
          !sync.data ? null : failed ? (
            <Status failed>Sync failed</Status>
          ) : next ? (
            <Badge>Step 2 of 2</Badge>
          ) : connected ? (
            <Status done>Connected</Status>
          ) : !sync.data.enabled ? (
            <Status>Not available</Status>
          ) : (
            <Status>Not connected</Status>
          )
        }
        description={
          failed ? (
            <span title={failed} className="line-clamp-3">
              {failed}
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
        learnMore={{
          href: openAppaUrl(
            "/validation#make-policy-tests-a-required-ci-check",
          ),
          label: "Test changes in CI",
        }}
        action={
          !sync.data?.enabled ? null : !canManage ? (
            connected ? null : (
              <p className="text-sm text-muted-foreground">
                Ask an administrator to connect a repository.
              </p>
            )
          ) : failed ? (
            <Button size="sm" onClick={() => setEditing(true)}>
              <Github />
              <span>Edit connection</span>
            </Button>
          ) : connected ? (
            <Button size="sm" variant="outline" asChild>
              <Link href="/settings/openappa">
                <span>Sync settings</span>
                <ArrowRight />
              </Link>
            </Button>
          ) : (
            <Button
              size="sm"
              variant={next ? "default" : "outline"}
              onClick={() => setEditing(true)}
            >
              <Github />
              <span>Connect GitHub</span>
            </Button>
          )
        }
      />
      {editing && (
        <OpenAppaSourceForm source={source} onOpenChange={setEditing} />
      )}
    </>
  );
}

function LearnMoreCard() {
  const appName = useAppName();
  return (
    <StatusCard
      icon={<BookOpen />}
      title="How it works"
      description={`${appName}'s guardrail uses OpenAPPA to check that data only goes to people allowed to see it.`}
      action={
        <ExternalDocsLink
          href={openAppaUrl("/how-it-works")}
          className="text-sm"
        >
          Read about OpenAPPA
        </ExternalDocsLink>
      }
    />
  );
}

function StatusCard({
  next,
  icon,
  title,
  status,
  description,
  learnMore,
  action,
}: {
  next?: boolean;
  icon: ReactNode;
  title: string;
  status?: ReactNode;
  description: ReactNode;
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
      <CardContent className="flex-1 px-4">
        <CardDescription className="leading-relaxed">
          {description}
        </CardDescription>
      </CardContent>
      <CardFooter className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4">
        {action}
        {learnMore && (
          <ExternalDocsLink href={learnMore.href} className="text-sm">
            {learnMore.label}
          </ExternalDocsLink>
        )}
      </CardFooter>
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
