// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
"use client";

import type { ResourceVisibilityScope } from "@archestra/shared";
import type { ReactNode } from "react";
import { SCOPE_META } from "@/components/scope-vocabulary";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { UnstyledButton } from "@/components/ui/unstyled-button";
import { cn } from "@/lib/utils/tailwind";

/**
 * Who an object reaches, read off its grants. It is never set directly: the
 * chip follows the grants, so it changes the moment one is added or removed.
 */
export function AudienceChip({
  audience,
  className,
}: {
  audience: ResourceVisibilityScope;
  className?: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <UnstyledButton
          aria-label={`Audience: ${AUDIENCE_LABELS[audience]}`}
          aria-description={AUDIENCE_TOOLTIP}
          data-testid="audience-chip"
          className={cn(
            "inline-flex w-fit shrink-0 cursor-default items-center rounded-full border px-2.5 py-px text-xs font-medium whitespace-nowrap outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
            AUDIENCE_STYLES[audience],
            className,
          )}
        >
          <span>{AUDIENCE_LABELS[audience]}</span>
        </UnstyledButton>
      </TooltipTrigger>
      <TooltipContent>{AUDIENCE_TOOLTIP}</TooltipContent>
    </Tooltip>
  );
}

/**
 * The access block's header: what the grants add up to.
 */
export function AccessAudienceHeader({
  audience,
  action,
}: {
  audience: ResourceVisibilityScope;
  action?: ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <h3 className="text-sm font-semibold">Who can use it</h3>
        <AudienceChip audience={audience} />
      </div>
      {action}
    </div>
  );
}

// One step darker per step wider: dashed outline, tinted fill, solid fill.
const AUDIENCE_STYLES: Record<ResourceVisibilityScope, string> = {
  personal: "border-dashed border-muted-foreground/50 text-foreground",
  team: "border-transparent bg-muted text-foreground",
  org: "border-transparent bg-primary text-primary-foreground",
};

const AUDIENCE_LABELS: Record<ResourceVisibilityScope, string> = {
  personal: SCOPE_META.personal.label,
  team: "Team-wide",
  org: "Org-wide",
};

const AUDIENCE_TOOLTIP =
  "Set from the grants below. It changes when you add or remove grants.";
