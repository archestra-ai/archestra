"use client";

import type { archestraApiTypes } from "@archestra/shared";
import Link from "next/link";
import type { ReactNode } from "react";
import { AgentBadge } from "@/components/agent-badge";
import { RowClickShield } from "@/components/agent-pages/row-click-shield";
import { LabelTags } from "@/components/label-tags";

type AgentLabels =
  archestraApiTypes.GetAgentsResponses["200"]["data"][number]["labels"];

export function AgentNameCell({
  name,
  href,
  builtIn = false,
  description,
  labels,
  extraBadges,
  icon,
}: {
  name: string;
  /**
   * When set, the name links to the entity's detail page. Left unset for rows
   * with no page to open, such as trashed records.
   */
  href?: string;
  builtIn?: boolean;
  description?: string | null;
  labels?: AgentLabels;
  extraBadges?: ReactNode;
  /**
   * The entity's icon, rendered inline before the name (as the knowledge
   * connectors table does) rather than in its own column, so the table isn't
   * spending a fixed slot of horizontal space on it.
   */
  icon?: ReactNode;
}) {
  const hasMetadata = !!extraBadges || !!labels?.length || builtIn;

  const content = (
    <div className="font-medium">
      <div className="flex flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          {href ? (
            // The row itself navigates to the same page; the link stays for
            // keyboard users and open-in-new-tab, and keeps its click to
            // itself so the row handler does not fire a second navigation.
            <Link
              href={href}
              className="max-w-full truncate leading-tight hover:underline"
              title={name}
              onClick={(e) => e.stopPropagation()}
            >
              {name}
            </Link>
          ) : (
            <span className="max-w-full truncate leading-tight" title={name}>
              {name}
            </span>
          )}
          {hasMetadata && (
            // `contents` keeps the badges in the row's flex flow while giving
            // their tooltips and label chips a node to swallow clicks on.
            <RowClickShield className="contents">
              {builtIn && <AgentBadge type="builtIn" />}
              {extraBadges}
              {labels && labels.length > 0 && <LabelTags labels={labels} />}
            </RowClickShield>
          )}
        </div>
        {description && (
          <div className="text-xs text-muted-foreground line-clamp-2">
            {description}
          </div>
        )}
      </div>
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
