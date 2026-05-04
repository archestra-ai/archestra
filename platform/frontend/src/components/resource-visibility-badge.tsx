"use client";

import type { ResourceVisibilityScope } from "@shared";
import { Globe, User, Users } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

type TeamInfo = { id: string; name: string };

export function ResourceVisibilityBadge({
  scope,
  teams,
  authorId,
  authorName,
  currentUserId,
}: {
  scope: ResourceVisibilityScope | undefined;
  teams: TeamInfo[] | undefined;
  authorId: string | null | undefined;
  authorName: string | null | undefined;
  currentUserId: string | undefined;
}) {
  const MAX_TEAMS_TO_SHOW = 3;
  const MAX_BADGE_TEXT_LENGTH = 15;

  if (scope === "org") {
    return (
      <Badge variant="secondary" className="text-xs">
        <Globe className="h-3 w-3" />
      </Badge>
    );
  }

  if (scope === "personal") {
    const displayName =
      currentUserId && authorId === currentUserId ? "Me" : authorName;
    if (!displayName) {
      return <span className="text-muted-foreground">-</span>;
    }

    return (
      <Badge
        variant="secondary"
        className="inline-flex max-w-[180px] items-center gap-1 overflow-hidden text-xs"
      >
        <User className="h-3 w-3 shrink-0" />
        <span className="min-w-0 flex-1 truncate">
          {truncateBadgeText(displayName, MAX_BADGE_TEXT_LENGTH)}
        </span>
      </Badge>
    );
  }

  if (!teams || teams.length === 0) {
    return (
      <Badge variant="secondary" className="text-xs gap-1">
        <Users className="h-3 w-3" />
        Team
      </Badge>
    );
  }

  const visibleTeams = teams.slice(0, MAX_TEAMS_TO_SHOW);
  const remainingTeams = teams.slice(MAX_TEAMS_TO_SHOW);

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1">
      {visibleTeams.map((team) => (
        <Badge
          key={team.id}
          variant="secondary"
          className="inline-flex max-w-[180px] items-center gap-1 overflow-hidden text-xs"
        >
          <Users className="h-3 w-3 shrink-0" />
          <span className="min-w-0 flex-1 truncate">
            {truncateBadgeText(team.name, MAX_BADGE_TEXT_LENGTH)}
          </span>
        </Badge>
      ))}
      {remainingTeams.length > 0 && (
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="text-xs text-muted-foreground cursor-help">
                +{remainingTeams.length} more
              </span>
            </TooltipTrigger>
            <TooltipContent>
              <div className="flex flex-col gap-1">
                {remainingTeams.map((team) => (
                  <div key={team.id} className="text-xs">
                    {team.name}
                  </div>
                ))}
              </div>
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      )}
    </div>
  );
}

function truncateBadgeText(value: string, maxLength: number): string {
  return value.length > maxLength
    ? `${value.slice(0, maxLength - 3)}...`
    : value;
}
