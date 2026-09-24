"use client";

import {
  ArrowRight,
  BatteryCharging,
  CircleCheck,
  Github,
  MessageCircle,
} from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { ExternalDocsLink } from "@/components/external-docs-link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useAppaGithubSync } from "@/lib/openappa-github-sync.query";
import { hasSource } from "./setup-rule";
import { openAppaUrl, type RuleDraft, RuleSentence } from "./setup-steps";

/**
 * The last setup step, after the rule is saved and OpenAPPA is on. The manual
 * rule was a way to learn; this points at how policies are really kept: an
 * agent writes them, GitHub tracks them, and batteries cover whole servers.
 */
export function NextStepsStep({ draft }: { draft: RuleDraft | null }) {
  const sync = useAppaGithubSync();
  const repo = sync.data?.source?.interval ? sync.data.source.repo : null;
  return (
    <div className="space-y-8">
      <div className="flex items-start gap-4">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 [&>svg]:size-5">
          <CircleCheck />
        </span>
        <div className="max-w-[65ch] space-y-2">
          <h2 className="text-xl font-semibold tracking-tight">
            OpenAPPA is on
          </h2>
          <p className="text-sm leading-relaxed text-muted-foreground">
            {draft ? (
              <span>
                <RuleSentence draft={draft} /> <TryIt draft={draft} />
              </span>
            ) : (
              <span>
                You skipped the first rule. The steps below are the quickest way
                to add rules.
              </span>
            )}
          </p>
        </div>
      </div>
      <section aria-labelledby="setup-next-steps" className="space-y-3">
        <div className="max-w-[65ch] space-y-1">
          <h3 id="setup-next-steps" className="text-sm font-medium">
            What to do next
          </h3>
          <p className="text-sm leading-relaxed text-muted-foreground">
            Your first rule showed how rules work. For the rest of your policy,
            start here.
          </p>
        </div>
        <ol className="divide-y rounded-lg border">
          <NextStep
            icon={<MessageCircle />}
            title="Let an agent write your policy"
            badge="Recommended"
            href="/openappa/configure"
            action="Open policy chat"
          >
            Describe what you want to protect in plain words. The agent reads
            your tools, proposes rules and validates them before anything is
            saved.
          </NextStep>
          <NextStep
            icon={<Github />}
            title="Track policy changes in GitHub"
            badge={repo ? `Connected to ${repo}` : undefined}
            href="/settings/openappa"
            action={repo ? "Open sync settings" : "Set up sync"}
            learnMore={{
              path: "/validation#make-policy-tests-a-required-ci-check",
              label: "Test policy changes in CI",
            }}
          >
            Keep the policy in a repository. Changes go through pull requests,
            so each one is reviewed and has a history you can roll back.
          </NextStep>
          <NextStep
            icon={<BatteryCharging />}
            title="Install batteries"
            href="/openappa/batteries"
            action="Browse batteries"
            learnMore={{ path: "/batteries", label: "Learn what a battery is" }}
          >
            A battery is a ready-made policy for one service&apos;s tools, such
            as GitHub, Slack or Linear. One install covers many tools at once.
          </NextStep>
        </ol>
      </section>
    </div>
  );
}

/** How to see the saved rule stop a call, in the words of its shape. */
function TryIt({ draft }: { draft: RuleDraft }) {
  const tool = (name?: string) => (
    <code className="font-mono text-foreground">{name}</code>
  );
  if (hasSource(draft.shape))
    return (
      <span>
        Try it in a new chat: ask an agent to use {tool(draft.source?.name)},
        then {tool(draft.guarded?.name)}.
      </span>
    );
  return (
    <span>
      Try it in a new chat: ask an agent to use {tool(draft.guarded?.name)}
      {draft.shape === "repeat" ? " twice." : "."}
    </span>
  );
}

function NextStep({
  icon,
  title,
  badge,
  href,
  action,
  learnMore,
  children,
}: {
  icon: ReactNode;
  title: string;
  badge?: string;
  href: string;
  action: string;
  /** A page of the OpenAPPA site that explains the idea behind this step. */
  learnMore?: { path: string; label: string };
  children: ReactNode;
}) {
  return (
    <li className="grid gap-3 p-4 sm:grid-cols-[auto_minmax(0,1fr)_auto] sm:items-center sm:gap-4">
      <span className="hidden size-8 items-center justify-center rounded-md bg-primary/10 text-primary sm:flex [&>svg]:size-4">
        {icon}
      </span>
      <div className="min-w-0 space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-sm font-medium">{title}</p>
          {badge && <Badge variant="secondary">{badge}</Badge>}
        </div>
        <p className="text-sm leading-relaxed text-muted-foreground">
          {children}
        </p>
        {learnMore && (
          <ExternalDocsLink
            href={openAppaUrl(learnMore.path)}
            className="text-sm"
          >
            {learnMore.label}
          </ExternalDocsLink>
        )}
      </div>
      <Button
        variant="outline"
        size="sm"
        className="justify-self-start"
        asChild
      >
        <Link href={href}>
          <span>{action}</span>
          <ArrowRight />
        </Link>
      </Button>
    </li>
  );
}
