"use client";

import type { ResourceVisibilityScope } from "@archestra/shared";
import { UserRoundCheck } from "lucide-react";
import { SCOPE_META, scopeStyles } from "@/components/scope-vocabulary";
import { Badge } from "@/components/ui/badge";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

export function ResourceVisibilityBadge({
  scope,
  teams,
  users,
  authorId,
  authorName,
  currentUserId,
  showSelfAsMe,
  compact = false,
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
   * How to label a personal resource the current user owns. Required, with no
   * default, because either answer is silently invisible if you guess wrong and
   * the wrong one renders an empty cell — which is exactly how two shipped bugs
   * got in. Deciding is one line; noticing a blank cell in review is not.
   *
   * Pass `true` when one column mixes personal, team and organization rows: a
   * blank cell on the viewer's own row among labelled ones reads as missing
   * data, so "Me" keeps every row attributed.
   *
   * Pass `false` when the surface already segregates owners — a grid split
   * under "Personal" and "Shared" headings, or a list scoped to one user —
   * where a "Me" pill on every row is noise.
   */
  showSelfAsMe: boolean;
  /**
   * Name the scope rather than enumerate it: one "Team" / "N teams" pill in
   * place of a pill per team. For surfaces where the badge is one item among
   * many competing for a single line — a card's metadata row — and the point is
   * which kind of resource this is, not the roster. The names stay reachable in
   * the tooltip. Columns headed "Accessible to" want the roster; leave it off.
   */
  compact?: boolean;
}) {
  // An unknown scope says nothing rather than guessing. Falling through to the
  // team branch would label a resource "Team" on no evidence, which is worse
  // than an empty cell: a wrong badge is believed, a missing one is queried.
  if (!scope) {
    return null;
  }

  if (scope === "org") {
    return (
      <Badge
        variant="outline"
        title="Organization"
        className={cn(
          scopeStyles.org,
          BADGE_WIDTH,
          "inline-flex items-center gap-1 overflow-hidden text-xs",
        )}
      >
        <OrgIcon className="h-3 w-3 shrink-0" />
        <span className="truncate">Organization</span>
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

    if (sharedWith.length === 0) {
      return (
        <Badge
          variant="outline"
          // `title` so a name the layout had to truncate is still readable.
          title={displayName ?? undefined}
          className={cn(
            scopeStyles.personal,
            BADGE_WIDTH,
            "inline-flex items-center gap-1 overflow-hidden text-xs",
          )}
        >
          <PersonalIcon className="h-3 w-3 shrink-0" />
          <span className="min-w-0 flex-1 truncate">{displayName}</span>
        </Badge>
      );
    }

    // One pill, not one per grantee: a resource shared with ten people would
    // otherwise flood a table cell. The distinct icon and count say it is
    // shared; hovering says with whom, as the apps card does.
    const label = `Shared with: ${sharedWith.map((user) => user.name).join(", ")}`;
    return (
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <Badge
              variant="outline"
              aria-label={label}
              className={cn(
                scopeStyles.personal,
                BADGE_WIDTH,
                "inline-flex cursor-help items-center gap-1 overflow-hidden text-xs",
              )}
            >
              <UserRoundCheck className="h-3 w-3 shrink-0" />
              <span className="min-w-0 truncate">
                {displayName ?? sharedWith[0].name}
              </span>
              <span className="shrink-0 opacity-70">+{sharedWith.length}</span>
            </Badge>
          </TooltipTrigger>
          <TooltipContent>{label}</TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
  }

  if (!teams || teams.length === 0 || compact) {
    // Named, not enumerated. With no teams to name there is nothing else to
    // say; under `compact` the caller has asked for the scope only, and the
    // roster moves to the tooltip.
    const names = (teams ?? []).map((team) => team.name);
    const label = names.length > 1 ? `${names.length} teams` : "Team";
    const badge = (
      <Badge
        variant="outline"
        title={names.length > 0 ? names.join(", ") : "Team"}
        className={cn(
          scopeStyles.team,
          BADGE_WIDTH,
          "inline-flex items-center gap-1 overflow-hidden text-xs",
        )}
      >
        <TeamIcon className="h-3 w-3 shrink-0" />
        <span className="truncate">{label}</span>
      </Badge>
    );
    if (names.length === 0) {
      return badge;
    }
    return (
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>{badge}</TooltipTrigger>
          <TooltipContent>{names.join(", ")}</TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
  }

  return (
    <PillRow
      pills={teams.map((team) => ({
        key: `team:${team.id}`,
        name: team.name,
        icon: TeamIcon,
      }))}
      style={scopeStyles.team}
    />
  );
}

/**
 * Never wider than whatever contains it, and never more than 180px even when
 * there is room. The container half matters: this badge sits in fixed-layout
 * table cells narrower than 180px, where a bare `max-w-[180px]` let it render
 * over the next column instead of truncating inside its own.
 */
const BADGE_WIDTH = "max-w-[min(100%,180px)]";

const OrgIcon = SCOPE_META.org.icon;
const PersonalIcon = SCOPE_META.personal.icon;
const TeamIcon = SCOPE_META.team.icon;

type TeamInfo = { id: string; name: string };
type UserInfo = { id: string; name: string };
type Pill = { key: string; name: string; icon: typeof TeamIcon };

const MAX_PILLS_TO_SHOW = 3;

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
          // `title` so a name the layout had to truncate is still readable.
          title={name}
          className={cn(
            style,
            BADGE_WIDTH,
            "inline-flex items-center gap-1 overflow-hidden text-xs",
          )}
        >
          <Icon className="h-3 w-3 shrink-0" />
          <span className="min-w-0 flex-1 truncate">{name}</span>
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
