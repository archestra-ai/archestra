import { useMemo } from "react";
import { useHasPermissions, useSession } from "@/lib/auth/auth.query";
import { useMyTeams } from "@/lib/teams/team.query";

/** Team membership opens only the team's limits, never organization cost analytics. */
export function useTeamLimitAccess() {
  const session = useSession();
  const read = useHasPermissions({ llmLimit: ["read"] });
  const create = useHasPermissions({ llmLimit: ["create"] });
  const update = useHasPermissions({ llmLimit: ["update"] });
  const remove = useHasPermissions({ llmLimit: ["delete"] });
  const membership = useMyTeams({
    enabled: !!session?.data?.user,
    includeDescendants: true,
  });
  const globalCreate = !!create?.data;
  const globalUpdate = !!update?.data;
  const globalDelete = !!remove?.data;
  return useMemo(() => {
    const roots = (membership?.data ?? []).filter(
      (team) => team.myRole === "admin",
    );
    const descendants = roots.flatMap((team) =>
      (team.descendantTeams ?? []).map((child) => ({
        ...child,
        description: null,
      })),
    );
    const teams = [
      ...new Map(
        [...roots, ...descendants].map((team) => [team.id, team]),
      ).values(),
    ];
    const managedTeams = teams.filter(
      (team) => !roots.some((root) => root.id === team.id),
    );
    const isTeamAdmin = roots.length > 0;
    const canRead = read?.data || isTeamAdmin;
    const administers = (target: { entityType: string; entityId: string }) =>
      target.entityType === "team" &&
      managedTeams.some((team) => team.id === target.entityId);
    return {
      teams,
      managedTeams,
      isTeamAdmin,
      canRead,
      globalCreate,
      globalRead: !!read?.data,
      isPending: read?.isPending || (!read?.data && membership?.isPending),
      allows(action: "create" | "update" | "delete", target?: LimitTarget) {
        const global = {
          create: globalCreate,
          update: globalUpdate,
          delete: globalDelete,
        }[action];
        if (global) return true;
        if (!target) return managedTeams.length > 0;
        return administers(target);
      },
      /** A lead can see their own ceiling, but cannot raise or reset it. */
      isLocked(target: LimitTarget) {
        return !globalUpdate && !administers(target);
      },
    };
  }, [
    membership?.data,
    membership?.isPending,
    read?.data,
    read?.isPending,
    globalCreate,
    globalUpdate,
    globalDelete,
  ]);
}

type LimitTarget = {
  entityType: string;
  entityId: string;
  teamManaged?: boolean;
};
