import type { archestraApiTypes } from "@archestra/shared";
import { useHasPermissions, useSession } from "@/lib/auth/auth.query";
import { useMyTeams } from "@/lib/teams/team.query";

type CatalogItem =
  archestraApiTypes.GetInternalMcpCatalogResponses["200"][number];

/**
 * Frontend mirror of the backend `requireMcpCatalogModifyPermission` rule that
 * gates editing a catalog item's metadata/config/visibility: an
 * mcpServerInstallation admin, the author of a personal item, or an admin of one
 * of the item's teams that holds the `write` access level.
 */
export function useCanModifyCatalogItem(
  catalog: CatalogItem | null | undefined,
): { canModify: boolean; isLoading: boolean } {
  const { data: isAdmin, isLoading: isAdminLoading } = useHasPermissions({
    mcpServerInstallation: ["admin"],
  });
  const { data: canReadTeams } = useHasPermissions({ team: ["read"] });
  const { data: userTeams, isLoading: teamsLoading } = useMyTeams({
    enabled: !!canReadTeams,
  });
  const { data: session, isPending: isSessionLoading } = useSession();
  const isLoading =
    isAdminLoading || isSessionLoading || (!!canReadTeams && teamsLoading);

  if (!catalog) return { canModify: false, isLoading };
  if (isAdmin) return { canModify: true, isLoading };

  const currentUserId = session?.user?.id;
  if (catalog.scope === "personal") {
    return {
      canModify: !!currentUserId && catalog.authorId === currentUserId,
      isLoading,
    };
  }
  if (catalog.scope === "team") {
    const adminTeamIds = new Set(
      (userTeams ?? []).filter((t) => t.myRole === "admin").map((t) => t.id),
    );
    return {
      canModify: !!catalog.teams?.some(
        (t) => t.level === "write" && adminTeamIds.has(t.id),
      ),
      isLoading,
    };
  }
  return { canModify: false, isLoading };
}
