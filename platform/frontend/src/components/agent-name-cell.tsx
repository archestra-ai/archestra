"use client";

import type { archestraApiTypes } from "@archestra/shared";
import type { ReactNode } from "react";
import { RowClickShield } from "@/components/agent-pages/row-click-shield";
import { BuiltInAgentBadge } from "@/components/built-in-agent-badge";
import { IntentPrefetchLink } from "@/components/intent-prefetch-link";
import { LabelTags } from "@/components/label-tags";
import { PersonalResourceOwner } from "@/components/personal-resource-owner";
import { UnstyledButton } from "@/components/ui/unstyled-button";

type AgentLabels = archestraApiTypes.GetAgentResponses["200"]["labels"];

export function AgentNameCell({
  name,
  href,
  onClick,
  builtIn = false,
  description,
  labels,
  extraBadges,
  nameIndicator,
  icon,
  owner,
}: {
  name: string;
  /**
   * When set, the name links to the entity's detail page. Left unset for rows
   * with no page to open, such as trashed records.
   */
  href?: string;
  /** Open an entity dialog when it has no separate detail page. */
  onClick?: () => void;
  builtIn?: boolean;
  description?: string | null;
  labels?: AgentLabels;
  extraBadges?: ReactNode;
  /** Compact trailing affordance that stays visible when metadata badges wrap. */
  nameIndicator?: ReactNode;
  /**
   * The entity's icon, rendered inline before the name (as the knowledge
   * connectors table does) rather than in its own column, so the table isn't
   * spending a fixed slot of horizontal space on it.
   */
  icon?: ReactNode;
  owner?: {
    resource: {
      scope: "personal" | "team" | "org";
      authorId: string | null;
      authorEmail?: string | null;
    };
    currentUserId: string | null | undefined;
  };
}) {
  const hasMetadata = !!extraBadges || !!labels?.length || builtIn;

  // Two short lines whatever the row holds — name and badges, then owner and
  // description — so rows keep one height and a long description cannot make
  // one of them several times taller than the rest.
  const content = (
    <div className="min-w-0 font-medium">
      <div
        className={
          nameIndicator
            ? "flex min-w-0 items-center gap-2 [&>a]:min-w-0 [&>a]:shrink [&>button]:min-w-0 [&>button]:shrink [&>span]:min-w-0 [&>span]:shrink"
            : "flex min-w-0 items-center gap-2"
        }
      >
        {href ? (
          // The row itself navigates to the same page; the link stays for
          // keyboard users and open-in-new-tab, and keeps its click to
          // itself so the row handler does not fire a second navigation. It
          // prefetches on hover or focus, not for every row in view.
          <IntentPrefetchLink
            href={href}
            className="max-w-full shrink-0 truncate leading-tight hover:underline"
            title={name}
            onClick={(e) => e.stopPropagation()}
          >
            {name}
          </IntentPrefetchLink>
        ) : onClick ? (
          <UnstyledButton
            type="button"
            className="max-w-full shrink-0 truncate leading-tight hover:underline"
            title={name}
            onClick={(event) => {
              event.stopPropagation();
              onClick();
            }}
          >
            {name}
          </UnstyledButton>
        ) : (
          <span
            className="max-w-full shrink-0 truncate leading-tight"
            title={name}
          >
            {name}
          </span>
        )}
        {nameIndicator && (
          <RowClickShield className="flex shrink-0 items-center empty:hidden">
            {nameIndicator}
          </RowClickShield>
        )}
        {hasMetadata && (
          // The name comes first and keeps its width; badges take what is
          // left. One that does not fit wraps onto a second line this box
          // hides, so a badge is shown whole or not at all, never cut. The
          // empty first item gives even the first badge a line to wrap from:
          // a flex line's only item stays on it however wide it is.
          <RowClickShield className="flex h-6 min-w-0 flex-1 flex-wrap content-start items-center gap-x-1.5 gap-y-2 overflow-hidden [&>*]:shrink-0">
            <span aria-hidden="true" className="-mr-1.5 h-6 w-0" />
            {builtIn && <BuiltInAgentBadge />}
            {extraBadges}
            {labels && labels.length > 0 && <LabelTags labels={labels} />}
          </RowClickShield>
        )}
      </div>
      {(owner || description) && (
        // One line: the owner and the description each truncate rather
        // than wrap, so a long owner email cannot make the row taller. The
        // owner keeps its width, up to a cap; the description gives way.
        <div className="mt-0.5 flex min-w-0 items-center gap-1 text-xs font-normal text-muted-foreground [&>span:not(:last-child)]:max-w-[60%] [&>span]:shrink-0 [&>span]:truncate">
          {owner && <PersonalResourceOwner {...owner} />}
          {description && (
            // The separator only when an owner was actually written before
            // it: the owner line renders nothing for an org-wide record.
            <span
              className="min-w-0 !max-w-none !shrink truncate [&:not(:first-child)]:before:content-['·_']"
              title={description}
            >
              {description}
            </span>
          )}
        </div>
      )}
    </div>
  );

  if (!icon) return content;

  return (
    <div className="flex min-w-0 items-center gap-3">
      <span className="flex shrink-0 items-center justify-center">{icon}</span>
      <div className="min-w-0">{content}</div>
    </div>
  );
}
