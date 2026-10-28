"use client";

import { Info } from "lucide-react";
import { AccountChip } from "@/components/github-app-setup/account-chip";
import { ResourceAccessSection } from "@/components/resource-access-section";
import { InlineNotice, InlineNoticeText } from "@/components/ui/inline-notice";

/**
 * The connect wizard and the Manage dialog share the medium width and frame,
 * each with a fixed height, so neither resizes as its content changes. The
 * body scrolls inside; the footer stays pinned. The wizard's 37rem fits its
 * tallest step with room for a two-line error; Manage's 46rem fits it with
 * Advanced folded.
 */
export const COPILOT_CONNECT_DIALOG_CLASS = "h-[min(37rem,85vh)]";
export const COPILOT_MANAGE_DIALOG_CLASS = "h-[min(46rem,85vh)]";

/** The organization a GitHub Copilot plan bills, as both dialogs show it. */
export function OrganizationRow({ organization }: { organization: string }) {
  return (
    <p className="flex items-center gap-2 text-sm text-muted-foreground">
      <span>Organization</span>
      <AccountChip account={organization} />
    </p>
  );
}

/**
 * Who may use the plan, and how to cap what it costs. The wizard's Access
 * step and the Manage dialog show the same section.
 */
export function CopilotAccess({
  keyId,
  registerSave,
  onDirtyChange,
}: {
  keyId: string;
  /** From a dialog with its own Save, which then commits the permissions. */
  registerSave?: (save: (() => Promise<void>) | null) => void;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  return (
    <div className="space-y-4">
      <ResourceAccessSection
        resource="llmProviderApiKey"
        id={keyId}
        registerSave={registerSave}
        onDirtyChange={onDirtyChange}
      />
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
