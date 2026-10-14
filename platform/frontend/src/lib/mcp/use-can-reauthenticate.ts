"use client";

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
 * A personal connection is its owner's alone: re-authenticating signs in with
 * the caller's own account, so anyone else would replace the owner's sign-in
 * with theirs. Installation admins may act on team and org connections.
 * Otherwise: team member with update; org denied. All paths require create.
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
  const { data: hasAdminPermission } = useHasPermissions(
    { mcpRegistry: ["update"] },
    "*",
  );

  // Stable across renders while the queries it reads are unchanged: callers
  // memoize on this reference (the issue rule behind the sidebar count runs
  // on every page), and a fresh closure each render would defeat that.
  return useCallback(
    (server: ReauthCandidate): boolean => {
      const scope = server.scope ?? (server.teamId ? "team" : "personal");
      if (scope === "personal") {
        return !!hasCreatePermission && server.ownerId === currentUserId;
      }
      if (hasAdminPermission) return true;
      if (!hasCreatePermission) return false;
      if (scope === "org") return false;

      const team = server.teamId
        ? userTeams?.find((t) => t.id === server.teamId)
        : undefined;
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
