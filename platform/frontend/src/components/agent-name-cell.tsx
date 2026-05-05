"use client";

import type { AgentScope, archestraApiTypes } from "@shared";
import type { ReactNode } from "react";
import { AgentBadge } from "@/components/agent-badge";
import { LabelTags } from "@/components/label-tags";

type AgentLabels =
  archestraApiTypes.GetAgentsResponses["200"]["data"][number]["labels"];

const MAX_NAME_LENGTH = 20;

export function AgentNameCell({
  name,
  scope,
  builtIn = false,
  description,
  labels,
  extraBadges,
}: {
  name: string;
  scope: AgentScope;
  builtIn?: boolean;
  description?: string | null;
  labels?: AgentLabels;
  extraBadges?: ReactNode;
}) {
  const hasMetadata = !!extraBadges || !!labels?.length || builtIn || !!scope;
  const displayName = truncateName(name);

  return (
    <div className="font-medium">
      <div className="flex flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="leading-tight" title={name}>
            {displayName}
          </span>
          {hasMetadata && (
            <>
              <AgentBadge type={builtIn ? "builtIn" : scope} />
              {extraBadges}
              {labels && labels.length > 0 && <LabelTags labels={labels} />}
            </>
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
