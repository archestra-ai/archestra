"use client";

import { MessageCircle } from "lucide-react";
import { ExternalDocsLink } from "@/components/external-docs-link";
import { OpenAppaMascot } from "@/components/openappa-mascot";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { useAppaGithubSync } from "@/lib/openappa-github-sync.query";
import { GithubManagedPolicyNotice } from "./github-managed-policy-notice";
import { OpenAppaChatButton } from "./openappa-chat-button";
import { useOpenAppaSetupState } from "./use-openappa-setup-state";

/**
 * Where OpenAPPA setup stands. A fresh organization sees only the first step,
 * saving a policy in the policy chat (which turns enforcement on). After that,
 * only a GitHub sync that needs attention shows here; enforcement sits in the
 * page header.
 */
export function OverviewSetupCards() {
  const { isFresh } = useOpenAppaSetupState();
  const sync = useAppaGithubSync();
  if (isFresh === undefined) return null;
  if (isFresh) return <PolicyStep />;
  const source = sync.data?.source;
  if (!source?.lastSyncError && !source?.setupPullRequestNumber) return null;
  return <GithubManagedPolicyNotice />;
}

/**
 * The whole page for an organization that has not saved a policy yet. There is
 * one thing to do here, so the page is that one thing: the mascot, what the
 * guardrail is for, and the button.
 */
function PolicyStep() {
  const { data: canEdit } = useHasPermissions({ guardrailsPolicy: ["update"] });
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

/** A page of the OpenAPPA site, where the concepts behind a card are explained. */
export function openAppaUrl(path: string): string {
  return `https://www.openappa.com${path}`;
}
