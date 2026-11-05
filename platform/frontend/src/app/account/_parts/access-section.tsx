"use client";

import {
  ADMIN_ROLE_NAME,
  getRoleDisplayName,
  PredefinedRoleNameSchema,
} from "@archestra/shared";
import { ShieldCheck } from "lucide-react";
import dynamic from "next/dynamic";
import {
  AccountRow,
  AccountRowMuted,
  AccountRows,
} from "@/app/account/_parts/account-rows";
import { QueryLoadError } from "@/components/query-load-error";
import { RoleOptionLabel } from "@/components/roles/role-type-icon";
import { SettingsSection } from "@/components/settings-section";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useSession } from "@/lib/auth/auth.query";
import { usePermissionSources } from "@/lib/auth/permission-sources.query";
import { useActiveMemberRole } from "@/lib/organization.query";
import { useMyTeams } from "@/lib/teams/team.query";

const PermissionsRows = dynamic(
  () =>
    // biome-ignore lint/style/noRestrictedImports: dual-licensed at request time
    import("@/app/account/_parts/permissions-rows.ee").then((m) => ({
      default: m.PermissionsRows,
    })),
  {
    loading: () => (
      <AccountRow label="Permissions">
        <Skeleton className="h-5 w-32" />
      </AccountRow>
    ),
  },
);

/**
 * What you have in the organization: your roles, your teams, and what the two
 * add up to. All read-only — an admin assigns them.
 *
 * Teams are often created and managed from chat, and the admin-only team
 * settings aren't reachable to members, so this is the one place a member can
 * see which teams they're in.
 *
 * The permissions are a reference you open on purpose, not something to
 * scroll past on every visit, so the row shows the count and unfolds the
 * list, the same one the roles pages draw, inside the box.
 */
export function AccessSection() {
  return (
    <SettingsSection
      title="Access"
      description="Your roles and teams, and the permissions they add up to."
    >
      <AccountRows label="Access">
        <AccountRow label="Roles">
          <RolesValue />
        </AccountRow>
        <AccountRow label="Teams">
          <TeamsValue />
        </AccountRow>
        <PermissionsRows />
      </AccountRows>
    </SettingsSection>
  );
}

/**
 * The roles held directly, then the ones a team passes on. A role held both
 * ways is listed once, as held directly.
 */
function RolesValue() {
  const { data: session, isPending: isSessionPending } = useSession();
  const hasActiveOrganization = !!session?.session?.activeOrganizationId;
  const { data: role, isPending: isRolePending } = useActiveMemberRole();
  const {
    data: sources,
    isPending: isSourcesPending,
    isLoadingError: isSourcesError,
    refetch: refetchSources,
  } = usePermissionSources();

  // The role query stays pending forever for a user with no active
  // organization (it never enables), so its wait only counts when the session
  // says there is an organization to have a role in. The team-granted roles
  // come from the sources query, so "None" waits for that one too.
  if (
    isSessionPending ||
    (hasActiveOrganization && (isRolePending || isSourcesPending))
  ) {
    return <Skeleton className="h-5 w-24" />;
  }

  const direct = (role ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const viaTeam = (sources ?? []).filter(
    (source) => source.team && !direct.includes(source.role),
  );

  if (direct.length === 0 && viaTeam.length === 0 && !isSourcesError) {
    return <AccountRowMuted>None</AccountRowMuted>;
  }

  return (
    <div className="space-y-2">
      {(direct.length > 0 || viaTeam.length > 0) && (
        <ul aria-label="Assigned roles" className="flex flex-wrap gap-1.5">
          {direct.map((value) => (
            <li key={value}>
              <RoleBadge role={value} />
            </li>
          ))}
          {viaTeam.map((source) => (
            <li key={`${source.role}:${source.team?.id}`}>
              <RoleBadge role={source.role} via={source.team?.name} />
            </li>
          ))}
        </ul>
      )}
      {isSourcesError && (
        <QueryLoadError
          className="py-1"
          title="Couldn't load the roles your teams grant"
          onRetry={() => refetchSources()}
        />
      )}
    </div>
  );
}

function RoleBadge({ role, via }: { role: string; via?: string }) {
  return (
    <Badge variant="secondary" className="gap-1.5 font-normal">
      <RoleOptionLabel
        predefined={PredefinedRoleNameSchema.safeParse(role).success}
        label={getRoleDisplayName(role)}
      />
      {via && <span className="text-muted-foreground">via {via}</span>}
    </Badge>
  );
}

function TeamsValue() {
  // isLoadingError, not isError: a failed background refetch keeps the last
  // good list on screen rather than replacing it with an error.
  const { data: teams, isPending, isLoadingError, refetch } = useMyTeams();

  if (isLoadingError) {
    return (
      <QueryLoadError
        className="py-2"
        title="Couldn't load your teams"
        onRetry={() => refetch()}
      />
    );
  }
  if (isPending) return <Skeleton className="h-5 w-40" />;
  if (teams.length === 0) return <AccountRowMuted>None</AccountRowMuted>;

  return (
    <ul aria-label="Your teams" className="flex flex-wrap gap-1.5">
      {teams.map((team) => (
        <li key={team.id}>
          <Badge
            variant="secondary"
            className="gap-1 font-normal"
            title={team.description ?? undefined}
          >
            {team.name}
            {team.myRole === ADMIN_ROLE_NAME && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="inline-flex text-muted-foreground">
                    <ShieldCheck className="size-3" aria-hidden="true" />
                    <span className="sr-only">Team admin</span>
                  </span>
                </TooltipTrigger>
                <TooltipContent>You're an admin of this team</TooltipContent>
              </Tooltip>
            )}
          </Badge>
        </li>
      ))}
    </ul>
  );
}
