// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
// SPDX-FileCopyrightText: 2026 Archestra Inc.

"use client";

import type { archestraApiTypes } from "@archestra/shared";
import { ShieldCheck } from "lucide-react";
import { ResourceVisibilityBadge } from "@/components/resource-visibility-badge";
import { Badge } from "@/components/ui/badge";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useTeams } from "@/lib/teams/team.query";

type ConnectorItem =
  archestraApiTypes.GetConnectorsResponses["200"]["data"][number];

/**
 * Who can retrieve the connector's documents, in the app's shared scope
 * badge language (org / teams). Auto-sync permissions is not a scope — the
 * audience mirrors the source system per document — so it gets its own
 * violet badge instead of pretending to be one.
 */
export function ConnectorAccessBadge({
  visibility,
  teamIds,
}: {
  visibility: ConnectorItem["visibility"];
  teamIds: string[];
}) {
  const { data: teams } = useTeams();

  if (visibility === "auto-sync-permissions") {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <Badge
            variant="outline"
            className="gap-1 text-xs bg-violet-500/10 text-violet-600 border-violet-500/30 dark:text-violet-400 dark:border-violet-400/30"
          >
            <ShieldCheck className="h-3 w-3" />
            Source permissions
          </Badge>
        </TooltipTrigger>
        <TooltipContent className="max-w-xs">
          Access mirrors the source system&apos;s own permissions — each user
          can retrieve only the documents they can access upstream.
        </TooltipContent>
      </Tooltip>
    );
  }

  return (
    <ResourceVisibilityBadge
      scope={visibility === "org-wide" ? "org" : "team"}
      teams={(teams ?? []).filter((team) => teamIds.includes(team.id))}
      authorId={undefined}
      authorName={undefined}
      currentUserId={undefined}
    />
  );
}
