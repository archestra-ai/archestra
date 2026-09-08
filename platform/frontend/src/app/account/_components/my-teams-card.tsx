"use client";

import { ADMIN_ROLE_NAME } from "@archestra/shared";
import { Users } from "lucide-react";
import { QueryLoadError } from "@/components/query-load-error";
import { SettingsBlock } from "@/components/settings/settings-block";
import { Badge } from "@/components/ui/badge";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { type Team, useMyTeams } from "@/lib/teams/team.query";

/**
 * Read-only list of the teams the signed-in user belongs to. Teams are often
 * created and managed from chat, so members had no place in the UI to see which
 * teams they're in — the admin-only team settings aren't reachable to them.
 * This section closes that gap without granting any management ability.
 */
export function MyTeamsCard() {
  // isLoadingError, not isError: a failed background refetch keeps the last
  // good list on screen rather than replacing it with an error panel.
  const { data: teams, isPending, isLoadingError, refetch } = useMyTeams();

  return (
    <SettingsBlock
      title="My Teams"
      description="Teams you belong to. Membership controls which agents and MCP servers you can use."
      control={null}
      // Kept to the same column width as the profile fields above it, so the
      // two sections read as one stacked list rather than a full-width table.
      contentClassName="max-w-xl"
    >
      {isLoadingError ? (
        <QueryLoadError
          className="py-6"
          title="Couldn't load your teams"
          onRetry={() => refetch()}
        />
      ) : isPending ? (
        <div className="space-y-2">
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
        </div>
      ) : teams.length === 0 ? (
        <Empty className="py-6">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Users />
            </EmptyMedia>
            <EmptyTitle>You're not in any teams yet</EmptyTitle>
            <EmptyDescription>
              When you're added to a team, or create one from chat, it shows up
              here.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <ul className="divide-y overflow-hidden rounded-lg border">
          {teams.map((team) => (
            <TeamRow key={team.id} team={team} />
          ))}
        </ul>
      )}
    </SettingsBlock>
  );
}

function TeamRow({ team }: { team: Team }) {
  const memberCount = team.members?.length ?? 0;
  const isAdmin = team.myRole === ADMIN_ROLE_NAME;

  return (
    <li className="flex flex-col gap-1 p-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
      <div className="min-w-0 space-y-0.5">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium">{team.name}</span>
          {team.myRole && (
            <Badge
              variant={isAdmin ? "secondary" : "outline"}
              className="capitalize"
            >
              {team.myRole}
            </Badge>
          )}
        </div>
        {team.description && (
          <p className="truncate text-sm text-muted-foreground">
            {team.description}
          </p>
        )}
      </div>
      <span className="shrink-0 text-xs text-muted-foreground">
        {memberCount === 1 ? "1 member" : `${memberCount} members`}
      </span>
    </li>
  );
}
