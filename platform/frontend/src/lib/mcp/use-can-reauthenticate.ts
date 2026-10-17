"use client";

import { canReauthenticateConnection } from "@archestra/shared";
import { useCallback, useMemo } from "react";
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

  const teamIds = useMemo(
    () => (userTeams ? new Set(userTeams.map((team) => team.id)) : undefined),
    [userTeams],
  );

  // Stable across renders while the queries it reads are unchanged: callers
  // memoize on this reference (the issue rule behind the sidebar count runs
  // on every page), and a fresh closure each render would defeat that.
  return useCallback(
    (server: ReauthCandidate): boolean =>
      canReauthenticateConnection({
        server,
        viewer: {
          userId: currentUserId,
          teamIds,
          canCreate: !!hasCreatePermission,
          canUpdate: !!hasUpdatePermission,
          isInstallsAdmin: !!hasAdminPermission,
        },
      }),
    [
      currentUserId,
      teamIds,
      hasCreatePermission,
      hasUpdatePermission,
      hasAdminPermission,
    ],
  );
}

/**
 * Whether everything {@link useCanReauthenticate} decides from has loaded:
 * the session, the viewer's own teams and the three permission checks. Before
 * that, its answers are guesses (no teams reads as "not a member"), so a rule
 * built on them must not be compared with anything yet. A failed teams read
 * is a guess too: it stays not ready until a retry loads the teams.
 */
export function useCanReauthenticateInputsReady(): boolean {
  const { isPending: sessionPending } = useSession();
  const { isPending: teamsPending, isError: teamsFailed } = useMyTeams();
  const { isPending: createPending } = useHasPermissions({
    mcpServerInstallation: ["create"],
  });
  const { isPending: updatePending } = useHasPermissions({
    mcpServerInstallation: ["update"],
  });
  const { isPending: adminPending } = useHasPermissions(
    { mcpRegistry: ["update"] },
    "*",
  );
  return (
    !sessionPending &&
    !teamsPending &&
    !teamsFailed &&
    !createPending &&
    !updatePending &&
    !adminPending
  );
}
