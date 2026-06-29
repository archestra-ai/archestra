"use client";

import type { ResourceVisibilityScope } from "@archestra/shared";
import { Globe, User, Users } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

type TeamInfo = { id: string; name: string };

// Scope colors mirror AgentBadge so apps/MCP/proxies/skills share one language.
export const scopeStyles = {
  personal:
    "bg-blue-500/10 text-blue-600 border-blue-500/30 dark:text-blue-400 dark:border-blue-400/30",
  team: "bg-green-500/10 text-green-600 border-green-500/30 dark:text-green-400 dark:border-green-400/30",
  org: "bg-amber-500/10 text-amber-600 border-amber-500/30 dark:text-amber-400 dark:border-amber-400/30",
} as const;

export function ResourceVisibilityBadge({
  scope,
  teams,
  authorId,
  authorName,
  currentUserId,
  showSelfAsMe = false,
}: {
  scope: ResourceVisibilityScope | undefined;
  teams: TeamInfo[] | undefined;
  authorId: string | null | undefined;
  authorName: string | null | undefined;
  currentUserId: string | undefined;
  /**
   * Controls how a personal resource owned by the current user is labelled. By
   * default that badge is hidden. Set this to render a "Me" badge instead: when
   * the same column also lists team- and organization-scoped resources, a blank
   * cell on the user's own row is confusing, so labelling it "Me" keeps every
   * row consistently attributed.
   */
  showSelfAsMe?: boolean;
}) {
  const MAX_TEAMS_TO_SHOW = 3;
  const MAX_BADGE_TEXT_LENGTH = 15;

  if (scope === "org") {
    return (
      <Badge variant="outline" className={cn(scopeStyles.org, "gap-1 text-xs")}>
        <Globe className="h-3 w-3" />
        Organization
      </Badge>
    );
  }

  if (scope === "personal") {
    const isSelf = !!currentUserId && authorId === currentUserId;
    // Hidden by default; callers opt in via showSelfAsMe to label the current
    // user's own row "Me" — needed for consistency when the same column also
    // lists team- and org-scoped rows, so the user's row isn't a confusing blank.
    if (isSelf && !showSelfAsMe) {
      return null;
    }
    const displayName = isSelf ? "Me" : authorName;
    if (!displayName) {
      return <span className="text-muted-foreground">-</span>;
    }

    return (
      <Badge
        variant="outline"
        className={cn(
          scopeStyles.personal,
          "inline-flex max-w-[180px] items-center gap-1 overflow-hidden text-xs",
        )}
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
      <Badge
        variant="outline"
        className={cn(scopeStyles.team, "gap-1 text-xs")}
      >
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
          variant="outline"
          className={cn(
            scopeStyles.team,
            "inline-flex max-w-[180px] items-center gap-1 overflow-hidden text-xs",
          )}
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
