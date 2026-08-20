"use client";

import type { archestraApiTypes } from "@archestra/shared";
import Link from "next/link";
import type { ReactNode } from "react";
import { AgentBadge } from "@/components/agent-badge";
import { RowClickShield } from "@/components/agent-pages/row-click-shield";
import { LabelTags } from "@/components/label-tags";

type AgentLabels =
  archestraApiTypes.GetAgentsResponses["200"]["data"][number]["labels"];

const MAX_NAME_LENGTH = 20;

export function AgentNameCell({
  name,
  href,
  builtIn = false,
  description,
  labels,
  extraBadges,
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
}) {
  const hasMetadata = !!extraBadges || !!labels?.length || builtIn;
  const displayName = truncateName(name);

  return (
    <div className="font-medium">
      <div className="flex flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          {href ? (
            // The row itself navigates to the same page; the link stays for
            // keyboard users and open-in-new-tab, and keeps its click to
            // itself so the row handler does not fire a second navigation.
            <Link
              href={href}
              className="leading-tight hover:underline"
              title={name}
              onClick={(e) => e.stopPropagation()}
            >
              {displayName}
            </Link>
          ) : (
            <span className="leading-tight" title={name}>
              {displayName}
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
}

function truncateName(name: string) {
  if (name.length <= MAX_NAME_LENGTH) {
    return name;
  }

  return `${name.slice(0, MAX_NAME_LENGTH)}...`;
}
