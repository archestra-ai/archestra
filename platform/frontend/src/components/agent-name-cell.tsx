"use client";

import type { AgentScope, archestraApiTypes } from "@shared";
import type { ReactNode } from "react";
import { AgentBadge } from "@/components/agent-badge";
import { LabelTags } from "@/components/label-tags";

type AgentLabels =
  archestraApiTypes.GetAgentsResponses["200"]["data"][number]["labels"];

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

  return (
    <div className="font-medium">
      <div className="flex flex-col gap-1">
        <div className="min-w-0 break-words leading-tight">{name}</div>
        {hasMetadata && (
          <div className="flex flex-wrap items-center gap-2">
            <AgentBadge type={builtIn ? "builtIn" : scope} />
            {extraBadges}
            {labels && labels.length > 0 && <LabelTags labels={labels} />}
          </div>
        )}
        {description && (
          <div className="text-[11px] text-muted-foreground line-clamp-2">
            {description}
          </div>
        )}
      </div>
    </div>
  );
}
