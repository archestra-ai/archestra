"use client";

import { Info } from "lucide-react";
import type { ReactNode } from "react";
import { AccountChip } from "@/components/github-app-setup/account-chip";
import { ResourceAccessSection } from "@/components/resource-access-section";
import { RuntimeCredentialIcon } from "@/components/runtime-credential-icon";
import { Badge } from "@/components/ui/badge";
import { InlineNotice, InlineNoticeText } from "@/components/ui/inline-notice";

/**
 * The wizard's one box, for Connect, Manage and Reconnect: the medium width
 * and a fixed height, so it never resizes between steps. 39rem fits the
 * tallest step (Manage's key form, with the App in use above it) and a
 * two-line error. The body scrolls inside; the footer stays pinned.
 */
export const COPILOT_DIALOG_CLASS = "h-[min(39rem,85vh)]";

/** The organization a GitHub Copilot plan bills. */
export function OrganizationRow({ organization }: { organization: string }) {
  return (
    <PlanRow label="Organization">
      <AccountChip account={organization} />
    </PlanRow>
  );
}

/** The GitHub App a plan uses, linked to it on GitHub when known. */
export function GithubAppRow({
  name,
  icon,
  url,
}: {
  name: string;
  icon: string | null;
  url: string | null;
}) {
  const chip = (
    <Badge variant="outline" className="bg-background font-normal">
      <RuntimeCredentialIcon
        icon={icon ?? "logo:github"}
        className="size-3"
        size={12}
      />
      <span>{name}</span>
    </Badge>
  );
  return (
    <PlanRow label="GitHub App">
      {url ? (
        <a
          href={url}
          target="_blank"
          rel="noreferrer"
          className="underline-offset-4 hover:underline"
        >
          {chip}
        </a>
      ) : (
        chip
      )}
    </PlanRow>
  );
}

/** Who may use the plan, and how to cap what it costs. */
export function CopilotAccess({ keyId }: { keyId: string }) {
  return (
    <div className="space-y-4">
      <ResourceAccessSection resource="llmProviderApiKey" id={keyId} />
      <InlineNotice variant="info">
        <Info aria-hidden />
        <InlineNoticeText>
          GitHub can't limit a single App. Set a cap in Costs & Limits, or turn
          on Stop usage when budget limit is reached in GitHub billing.
        </InlineNoticeText>
      </InlineNotice>
    </div>
  );
}

function PlanRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <p className="flex items-center gap-2 text-sm text-muted-foreground">
      <span className="w-24 shrink-0">{label}</span>
      {children}
    </p>
  );
}
