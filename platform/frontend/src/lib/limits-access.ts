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
  const membership = useMyTeams({ enabled: !!session?.data?.user });
  const globalCreate = !!create?.data;
  const globalUpdate = !!update?.data;
  const globalDelete = !!remove?.data;
  return useMemo(() => {
    const teams = (membership?.data ?? []).filter(
      (team) => team.myRole === "admin",
    );
    const isTeamAdmin = teams.length > 0;
    const canRead = read?.data || isTeamAdmin;
    return {
      teams,
      isTeamAdmin,
      canRead,
      globalCreate,
      globalRead: !!read?.data,
      isPending: read?.isPending || (!read?.data && membership?.isPending),
      allows(
        action: "create" | "update" | "delete",
        target?: { entityType: string; entityId: string },
      ) {
        const global = {
          create: globalCreate,
          update: globalUpdate,
          delete: globalDelete,
        }[action];
        return (
          !!global ||
          (target
            ? target.entityType === "team" &&
              teams.some((team) => team.id === target.entityId)
            : isTeamAdmin)
        );
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
