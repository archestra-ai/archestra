"use client";

import { ADMIN_ROLE_NAME } from "@archestra/shared";
import { useCallback } from "react";
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
 * Installation admins may act across every scope. Otherwise: personal owner;
 * team admin or a member with update; org denied. All paths require create.
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

  // Stable across renders while the queries it reads are unchanged: callers
  // memoize on this reference (the issue rule behind the sidebar count runs
  // on every page), and a fresh closure each render would defeat that.
  return useCallback(
    (server: ReauthCandidate): boolean => {
      if (hasAdminPermission) return true;
      if (!hasCreatePermission) return false;
      const scope = server.scope ?? (server.teamId ? "team" : "personal");

      if (scope === "org") return false;
      if (scope === "personal") return server.ownerId === currentUserId;

      const team = server.teamId
        ? userTeams?.find((t) => t.id === server.teamId)
        : undefined;
      const isTeamAdmin =
        !!currentUserId &&
        (team?.members?.some(
          (member) =>
            member.userId === currentUserId && member.role === ADMIN_ROLE_NAME,
        ) ??
          false);
      if (isTeamAdmin) return true;
      if (!hasUpdatePermission) return false;
      return !!team;
    },
    [
      currentUserId,
      userTeams,
      hasCreatePermission,
      hasUpdatePermission,
      hasAdminPermission,
    ],
  );
}
