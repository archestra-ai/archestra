// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
"use client";

import type { CreatedBy, ResourceVisibilityScope } from "@archestra/shared";
import { Building2, UserRound, Users } from "lucide-react";
import type { ReactNode } from "react";
import { CreatorAvatar, creatorLabel } from "@/components/created-by-cell";
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
 *
 * `owner` folds the record's owner into the same chip ("Personal · Ada"), so
 * a header states who it reaches and who to ask in one place. Omitted or null
 * (a built-in record, or no owner recorded) shows the audience alone. On
 * phones the owner shrinks to their avatar; the full name stays in the
 * accessible label and the tooltip.
 */
export function AudienceChip({
  audience,
  owner,
  className,
  compact = false,
}: {
  audience: ResourceVisibilityScope;
  owner?: CreatedBy | null;
  className?: string;
  compact?: boolean;
}) {
  const audienceLabel = AUDIENCE_LABELS[audience];
  const Icon = { personal: UserRound, team: Users, org: Building2 }[audience];
  const ownerName = owner ? creatorLabel(owner) : null;
  const ownerDetail =
    owner && ownerName
      ? owner.type === "service_account"
        ? `${ownerName} · Service account`
        : owner.email && owner.email !== ownerName
          ? `${ownerName} · ${owner.email}`
          : ownerName
      : null;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <UnstyledButton
          aria-label={
            ownerName
              ? `Audience: ${audienceLabel}, Owner: ${ownerName}`
              : `Audience: ${audienceLabel}`
          }
          aria-description={AUDIENCE_TOOLTIP}
          data-testid="audience-chip"
          className={cn(
            compact
              ? "inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
              : [
                  "inline-flex w-fit min-w-0 shrink-0 cursor-default items-center gap-1.5 rounded-full border px-2.5 py-px text-xs font-medium whitespace-nowrap outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
                  owner && "max-w-72 pr-1",
                  AUDIENCE_STYLES[audience],
                ],
            className,
          )}
        >
          {compact ? (
            <Icon className="size-4" aria-hidden />
          ) : (
            <span>{audienceLabel}</span>
          )}
          {!compact && owner && ownerName && (
            <span
              data-testid="audience-chip-owner"
              className="flex min-w-0 items-center gap-1.5 font-normal"
            >
              <span aria-hidden="true" className="opacity-60">
                ·
              </span>
              <span className="hidden min-w-0 truncate md:inline">
                {ownerName}
              </span>
              <CreatorAvatar
                createdBy={owner}
                className="size-4"
                fallbackClassName={cn(
                  "text-[9px]",
                  OWNER_AVATAR_STYLES[audience],
                )}
              />
            </span>
          )}
        </UnstyledButton>
      </TooltipTrigger>
      <TooltipContent>
        {compact && <p>{audienceLabel}</p>}
        {ownerDetail ? (
          <div className="flex flex-col gap-0.5">
            <span>{`Owner: ${ownerDetail}`}</span>
            <span>{AUDIENCE_TOOLTIP}</span>
          </div>
        ) : (
          AUDIENCE_TOOLTIP
        )}
      </TooltipContent>
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

// One step stronger per step wider: dashed outline, neutral fill, brand tint.
const AUDIENCE_STYLES: Record<ResourceVisibilityScope, string> = {
  personal: "border-dashed border-muted-foreground/50 text-foreground",
  team: "border-transparent bg-muted text-foreground",
  org: "border-primary/20 bg-primary/10 text-primary",
};

// The owner's avatar sits on the chip's own fill, so it takes a contrasting
// fill from the same tokens rather than the default muted one, which would
// vanish into the team chip.
const OWNER_AVATAR_STYLES: Record<ResourceVisibilityScope, string> = {
  personal: "bg-muted text-foreground",
  team: "bg-background text-foreground",
  org: "bg-primary/15 text-primary",
};

const AUDIENCE_LABELS: Record<ResourceVisibilityScope, string> = {
  personal: SCOPE_META.personal.label,
  team: "Team-wide",
  org: "Org-wide",
};

const AUDIENCE_TOOLTIP =
  "Set from the grants below. It changes when you add or remove grants.";
