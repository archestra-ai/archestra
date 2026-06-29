"use client";

import { ADMIN_ROLE_NAME } from "@archestra/shared";
import { useHasPermissions, useSession } from "@/lib/auth/auth.query";
import { useMyTeams } from "@/lib/teams/team.query";

type ReauthCandidate = {
  scope?: string | null;
  teamId?: string | null;
  ownerId?: string | null;
};

/**
 * Per-connection re-authentication permission, shared by the registry card and
 * the connections dialog so both gate the OAuth re-auth entry point identically.
 * Personal: owner only. Team: team-admin, or a member with mcpServer:update.
 * Org: mcpServerInstallation:admin. All paths require mcpServerInstallation:create.
 */
export function useCanReauthenticate() {
  const { data: session } = useSession();
  const currentUserId = session?.user?.id;
  const { data: userTeams } = useMyTeams();
  const { data: hasCreatePermission } = useHasPermissions({
    mcpServerInstallation: ["create"],
  });
  const { data: hasUpdatePermission } = useHasPermissions({
    mcpServerInstallation: ["update"],
  });
  const { data: hasAdminPermission } = useHasPermissions({
    mcpServerInstallation: ["admin"],
  });

  const isCurrentUserTeamAdmin = (teamId: string | null | undefined) => {
    if (!teamId || !currentUserId) return false;
    const team = userTeams?.find((t) => t.id === teamId);
    return (
      team?.members?.some(
        (member) =>
          member.userId === currentUserId && member.role === ADMIN_ROLE_NAME,
      ) ?? false
    );
  };

  return (server: ReauthCandidate): boolean => {
    if (!hasCreatePermission) return false;
    const scope = server.scope ?? (server.teamId ? "team" : "personal");

    if (scope === "org") return !!hasAdminPermission;
    if (scope === "personal") return server.ownerId === currentUserId;

    if (isCurrentUserTeamAdmin(server.teamId)) return true;
    if (!hasUpdatePermission) return false;
    return userTeams?.some((team) => team.id === server.teamId) ?? false;
  };
}
