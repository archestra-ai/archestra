"use client";

import type { ResourceVisibilityScope } from "@archestra/shared";
import { Globe, User, UserRoundCheck, Users } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

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
  users,
  authorId,
  authorName,
  currentUserId,
  showSelfAsMe = false,
}: {
  scope: ResourceVisibilityScope | undefined;
  teams: TeamInfo[] | undefined;
  /**
   * People the resource is shared with individually. Such a resource is stored
   * as `personal` plus grants, so reading the scope literally would attribute
   * it to its author alone — which is what this column is meant to answer.
   * Resources without per-user grants omit it and render exactly as before.
   */
  users?: UserInfo[] | null;
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
    const sharedWith = (users ?? []).filter((user) => user.name);
    // Hidden by default; callers opt in via showSelfAsMe to label the current
    // user's own row "Me" — needed for consistency when the same column also
    // lists team- and org-scoped rows, so the user's row isn't a confusing blank.
    // Grants override that: there is something to say once others can reach it.
    if (isSelf && !showSelfAsMe && sharedWith.length === 0) {
      return null;
    }
    const displayName = isSelf ? "Me" : authorName;
    if (!displayName && sharedWith.length === 0) {
      return <span className="text-muted-foreground">-</span>;
    }

    // Owner first, then everyone it was shared with, because the column asks
    // who can reach this rather than who owns it.
    return (
      <PillRow
        pills={[
          ...(displayName
            ? [{ key: "owner", name: displayName, icon: User }]
            : []),
          ...sharedWith.map((user) => ({
            key: `user:${user.id}`,
            name: user.name,
            icon: UserRoundCheck,
          })),
        ]}
        style={scopeStyles.personal}
      />
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

  return (
    <PillRow
      pills={teams.map((team) => ({
        key: `team:${team.id}`,
        name: team.name,
        icon: Users,
      }))}
      style={scopeStyles.team}
    />
  );
}

type TeamInfo = { id: string; name: string };
type UserInfo = { id: string; name: string };
type Pill = { key: string; name: string; icon: typeof User };

const MAX_PILLS_TO_SHOW = 3;
const MAX_BADGE_TEXT_LENGTH = 15;

/** A row of name pills, overflowing into a "+N more" tooltip. */
function PillRow({ pills, style }: { pills: Pill[]; style: string }) {
  const visible = pills.slice(0, MAX_PILLS_TO_SHOW);
  const remaining = pills.slice(MAX_PILLS_TO_SHOW);

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1">
      {visible.map(({ key, name, icon: Icon }) => (
        <Badge
          key={key}
          variant="outline"
          className={cn(
            style,
            "inline-flex max-w-[180px] items-center gap-1 overflow-hidden text-xs",
          )}
        >
          <Icon className="h-3 w-3 shrink-0" />
          <span className="min-w-0 flex-1 truncate">
            {truncateBadgeText(name, MAX_BADGE_TEXT_LENGTH)}
          </span>
        </Badge>
      ))}
      {remaining.length > 0 && (
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="text-xs text-muted-foreground cursor-help">
                +{remaining.length} more
              </span>
            </TooltipTrigger>
            <TooltipContent>
              <div className="flex flex-col gap-1">
                {remaining.map(({ key, name }) => (
                  <div key={key} className="text-xs">
                    {name}
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
