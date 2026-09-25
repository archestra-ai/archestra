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
import { useAppaGithubSync } from "@/lib/openappa-github-sync.query";
import { openAppaChatHref } from "@/lib/openappa-routes";
import { OpenAppaSourceForm } from "./appa-github-sync-panel";
import { useOpenAppaSetupState } from "./use-openappa-setup-state";

/**
 * The first things to do on OpenAPPA, each with where it stands: turn it on
 * with a policy the agent writes, keep that policy in GitHub, and learn the
 * model behind it.
 */
export function OverviewSetupCards() {
  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <EnforcementCard />
      <GithubSyncCard />
      <LearnMoreCard />
    </div>
  );
}

function EnforcementCard() {
  const { enabled, hasPolicy } = useOpenAppaSetupState();
  const promptKey = enabled
    ? "reviewPolicy"
    : hasPolicy
      ? "resumePolicy"
      : "setUpPolicy";
  return (
    <SetupCard
      icon={<ShieldCheck />}
      title="Enforcement"
      status={
        enabled === undefined ? null : enabled ? (
          <Status done>On</Status>
        ) : (
          <Status>Off</Status>
        )
      }
      description={
        enabled
          ? "Tool calls through the LLM Proxy and MCP Gateway are checked against your policy. Ask the policy agent to review or change it."
          : hasPolicy
            ? "Tool calls are not checked: enforcement is off. The policy agent can review your saved policy with you before you turn it back on."
            : "Tool calls are not checked yet. Tell the policy agent what to protect: it drafts your first rules, and saving them turns OpenAPPA on."
      }
      action={
        <Button size="sm" variant={enabled ? "outline" : "default"} asChild>
          <Link href={openAppaChatHref({ promptKey })}>
            <MessageCircle />
            <span>{enabled ? "Configure with chat" : "Set up with chat"}</span>
          </Link>
        </Button>
      }
    />
  );
}

function GithubSyncCard() {
  const sync = useAppaGithubSync();
  const { data: canManage } = useHasPermissions({ organization: ["update"] });
  const [editing, setEditing] = useState(false);
  const source = sync.data?.source ?? null;
  const connected = Boolean(source?.interval);
  return (
    <>
      <SetupCard
        icon={<Github />}
        title="GitHub sync"
        status={
          !sync.data ? null : source?.lastSyncError ? (
            <Status failed>Sync failed</Status>
          ) : connected ? (
            <Status done>Connected</Status>
          ) : (
            <Status>Not connected</Status>
          )
        }
        description={
          connected && source?.repo ? (
            <span>
              The policy is pulled from{" "}
              <span className="font-mono text-foreground">{source.repo}</span>.
              Changes go through pull requests, so each one is reviewed and can
              be rolled back.
            </span>
          ) : (
            <span>
              Keep the policy in a repository. Changes go through pull requests,
              so each one is reviewed and has a history you can roll back.
            </span>
          )
        }
        learnMore={{
          href: openAppaUrl(
            "/validation#make-policy-tests-a-required-ci-check",
          ),
          label: "Test changes in CI",
        }}
        action={
          connected ? (
            <Button size="sm" variant="outline" asChild>
              <Link href="/settings/openappa">
                <span>Open sync settings</span>
                <ArrowRight />
              </Link>
            </Button>
          ) : canManage && sync.data?.enabled ? (
            <Button size="sm" onClick={() => setEditing(true)}>
              <Github />
              <span>Connect GitHub</span>
            </Button>
          ) : sync.data ? (
            <p className="text-sm text-muted-foreground">
              Ask an administrator to connect a repository.
            </p>
          ) : null
        }
      />
      {editing && (
        <OpenAppaSourceForm source={source} onOpenChange={setEditing} />
      )}
    </>
  );
}

function LearnMoreCard() {
  return (
    <SetupCard
      icon={<BookOpen />}
      title="How it works"
      description="OpenAPPA tracks what each conversation has read and checks every tool call against your policy. A blocked call comes back with a way forward, such as asking a person to approve it."
      action={
        <ExternalDocsLink
          href={openAppaUrl("/how-it-works")}
          className="text-sm"
        >
          Read how it works
        </ExternalDocsLink>
      }
    />
  );
}

function SetupCard({
  icon,
  title,
  status,
  description,
  learnMore,
  action,
}: {
  icon: ReactNode;
  title: string;
  status?: ReactNode;
  description: ReactNode;
  learnMore?: { href: string; label: string };
  action: ReactNode;
}) {
  return (
    <Card className="gap-4 py-5">
      <CardHeader className="flex flex-wrap items-center gap-x-3 gap-y-2 px-5">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary [&>svg]:size-4">
          {icon}
        </span>
        <CardTitle className="flex-1 text-sm whitespace-nowrap">
          {title}
        </CardTitle>
        {status}
      </CardHeader>
      <CardContent className="flex-1 px-5">
        <CardDescription className="leading-relaxed">
          {description}
        </CardDescription>
      </CardContent>
      <CardFooter className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-5">
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
