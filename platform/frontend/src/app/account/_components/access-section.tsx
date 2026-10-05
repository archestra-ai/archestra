"use client";

import {
  getRoleDisplayName,
  PredefinedRoleNameSchema,
} from "@archestra/shared";
import { useState } from "react";
import {
  AccountRow,
  AccountRowMuted,
  AccountRows,
} from "@/app/account/_components/account-rows";
import { QueryLoadError } from "@/components/query-load-error";
import { RoleOptionLabel } from "@/components/role-type-icon";
import { PermissionsCard } from "@/components/settings/permissions-card";
import { SettingsSection } from "@/components/settings-section";
import { StandardDialog } from "@/components/standard-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useAllPermissions, useSession } from "@/lib/auth/auth.query";
import { useActiveMemberRole } from "@/lib/organization.query";
import { useMyTeams } from "@/lib/teams/team.query";

/**
 * What you have in the organization: your roles, your teams, and what the two
 * add up to. All read-only — an admin assigns them.
 *
 * Teams are often created and managed from chat, and the admin-only team
 * settings aren't reachable to members, so this is the one place a member can
 * see which teams they're in.
 *
 * The full permission matrix is a reference you open on purpose, not something
 * to scroll past on every visit, so it lives behind View.
 */
export function AccessSection() {
  const [isPermissionsOpen, setIsPermissionsOpen] = useState(false);

  return (
    <SettingsSection
      title="Access"
      description="Assigned by your organization admin."
    >
      <AccountRows label="Access">
        <AccountRow label="Role">
          <RoleValue />
        </AccountRow>
        <AccountRow label="Teams">
          <TeamsValue />
        </AccountRow>
        <AccountRow
          label="Permissions"
          action={
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setIsPermissionsOpen(true)}
            >
              View
            </Button>
          }
        >
          <PermissionCountValue />
        </AccountRow>
      </AccountRows>
      <StandardDialog
        open={isPermissionsOpen}
        onOpenChange={setIsPermissionsOpen}
        title="Your permissions"
        description="What your roles and teams let you do. Pick a permission to see where it comes from."
        size="medium"
      >
        <PermissionsCard />
      </StandardDialog>
    </SettingsSection>
  );
}

function RoleValue() {
  const { data: session, isPending: isSessionPending } = useSession();
  const hasActiveOrganization = !!session?.session?.activeOrganizationId;
  const { data: role, isPending: isRolePending } = useActiveMemberRole();

  // The role query stays pending forever for a user with no active
  // organization (it never enables), so its wait only counts when the session
  // says there is an organization to have a role in.
  if (isSessionPending || (hasActiveOrganization && isRolePending)) {
    return <Skeleton className="h-5 w-24" />;
  }

  const roles = (role ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

  if (roles.length === 0) return <AccountRowMuted>None</AccountRowMuted>;

  return (
    <ul aria-label="Assigned roles" className="flex flex-wrap gap-1.5">
      {roles.map((value) => (
        <li key={value}>
          <Badge variant="secondary" className="gap-1.5 font-normal">
            <RoleOptionLabel
              predefined={PredefinedRoleNameSchema.safeParse(value).success}
              label={getRoleDisplayName(value)}
            />
          </Badge>
        </li>
      ))}
    </ul>
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
            className="font-normal"
            title={team.description ?? undefined}
          >
            {team.name}
            {team.myRole && team.myRole !== "member" && (
              <span className="text-muted-foreground capitalize">
                · {team.myRole}
              </span>
            )}
          </Badge>
        </li>
      ))}
    </ul>
  );
}

function PermissionCountValue() {
  const { data: permissions, isLoading, isError } = useAllPermissions();

  if (isLoading) return <Skeleton className="h-5 w-32" />;
  if (isError) return <AccountRowMuted>Couldn't load</AccountRowMuted>;

  const granted = Object.values(permissions ?? {}).reduce(
    (sum, actions) => sum + (actions?.length ?? 0),
    0,
  );
  if (granted === 0) return <AccountRowMuted>None</AccountRowMuted>;
  return (
    <span>
      <span className="font-mono tabular-nums">{granted}</span> granted
    </span>
  );
}
