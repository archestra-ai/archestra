"use client";

import type { ReactNode } from "react";
import { AccountChip } from "@/components/github-app-setup/account-chip";
import { RuntimeCredentialIcon } from "@/components/runtime-credential-icon";
import { Badge } from "@/components/ui/badge";

/**
 * The wizard's one box, for Connect, Manage and Reconnect: the medium width
 * and a fixed height, so it never resizes between steps. 31rem fits every
 * step on the usual path (the tallest: the App step with the App in use);
 * a rare long error or list scrolls inside the body, the footer pinned.
 */
export const COPILOT_DIALOG_CLASS = "h-[min(31rem,85vh)]";

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

function PlanRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <p className="flex items-center gap-2 text-sm text-muted-foreground">
      <span className="w-24 shrink-0">{label}</span>
      {children}
    </p>
  );
}
