// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
"use client";

import type { CreatedBy, ResourceVisibilityScope } from "@archestra/shared";
import { Building2, Lock, UserRound, Users } from "lucide-react";
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
 *
 * `compact` is the icon beside a record's title: the owner's avatar with a
 * small audience badge, naming both on hover.
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

  if (compact) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <UnstyledButton
            aria-label={
              ownerName
                ? `Audience: ${audienceLabel}, Owner: ${ownerName}`
                : `Audience: ${audienceLabel}`
            }
            data-testid="audience-chip"
            className={cn(
              "inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-muted focus-visible:ring-[3px] focus-visible:ring-ring/50",
              className,
            )}
          >
            {owner ? (
              <span className="relative inline-flex">
                <CreatorAvatar
                  createdBy={owner}
                  className="size-5"
                  fallbackClassName="text-[9px] font-medium"
                />
                <span className="absolute -right-1 -bottom-1 inline-flex size-3 items-center justify-center rounded-full bg-background ring-1 ring-border">
                  <Icon className="size-2" strokeWidth={2.5} aria-hidden />
                </span>
              </span>
            ) : (
              <Icon className="size-4" aria-hidden />
            )}
          </UnstyledButton>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="px-2.5 py-1">
          {ownerName ? (
            <span className="flex flex-col leading-snug">
              <span className="font-medium">{ownerName}</span>
              <span className="text-muted-foreground">{audienceLabel}</span>
            </span>
          ) : (
            <span>{audienceLabel}</span>
          )}
        </TooltipContent>
      </Tooltip>
    );
  }

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
            "inline-flex w-fit min-w-0 shrink-0 cursor-default items-center gap-1.5 rounded-full border px-2.5 py-px text-xs font-medium whitespace-nowrap outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
            owner && "max-w-72 pr-1",
            AUDIENCE_STYLES[audience],
            className,
          )}
        >
          <span>{audienceLabel}</span>
          {owner && ownerName && (
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
  lockedReason,
}: {
  audience: ResourceVisibilityScope;
  action?: ReactNode;
  /** Why the viewer cannot change these grants; null when they can. */
  lockedReason?: string | null;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <h3 className="text-sm font-semibold">Who can use it</h3>
        <AudienceChip audience={audience} />
        {lockedReason && (
          <Tooltip>
            <TooltipTrigger asChild>
              <UnstyledButton
                type="button"
                aria-label={`You can't change permissions. ${lockedReason}`}
                className="inline-flex size-5 items-center justify-center rounded text-muted-foreground hover:text-foreground"
              >
                <Lock className="size-3.5" />
              </UnstyledButton>
            </TooltipTrigger>
            <TooltipContent className="max-w-xs">
              <div className="flex flex-col gap-0.5">
                <span className="font-medium">
                  You can&apos;t change permissions.
                </span>
                <span>{lockedReason}</span>
              </div>
            </TooltipContent>
          </Tooltip>
        )}
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
