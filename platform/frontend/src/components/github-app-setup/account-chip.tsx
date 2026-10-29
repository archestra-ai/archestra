"use client";

import type { GitProvider } from "@archestra/shared";
import { GitProviderLogo } from "@/components/git/git-setup-chrome";
import { Badge } from "@/components/ui/badge";

/** A Git account (an organization or user), as GitHub or GitLab names it. */
export function AccountChip({
  account,
  provider = "github",
}: {
  account: string;
  provider?: GitProvider;
}) {
  return (
    <Badge variant="outline" className="bg-background font-mono font-normal">
      <GitProviderLogo provider={provider} size={12} />
      <span>{account}</span>
    </Badge>
  );
}
