import type { archestraApiTypes } from "@shared";
import { useHasPermissions, useSession } from "@/lib/auth/auth.query";
import { useTeams } from "@/lib/teams/team.query";

type CatalogItem =
  archestraApiTypes.GetInternalMcpCatalogResponses["200"][number];

/**
 * Frontend mirror of the backend `requireMcpCatalogModifyPermission` rule that
 * gates editing a catalog item's metadata/config/visibility: an
 * mcpServerInstallation admin, a mcpRegistry:team-admin who is a member of one
 * of the item's teams (for team-scoped items), or the author of a personal
 * item.
 */
export function useCanModifyCatalogItem(
  catalog: CatalogItem | null | undefined,
): { canModify: boolean; isLoading: boolean } {
  const { data: isAdmin, isLoading: isAdminLoading } = useHasPermissions({
    mcpServerInstallation: ["admin"],
  });
  const { data: isTeamAdmin, isLoading: isTeamAdminLoading } =
    useHasPermissions({ mcpRegistry: ["team-admin"] });
  const { data: canReadTeams } = useHasPermissions({ team: ["read"] });
  const { data: userTeams, isLoading: teamsLoading } = useTeams({
    enabled: !!canReadTeams,
  });
  const { data: session, isPending: isSessionLoading } = useSession();
  const isLoading =
    isAdminLoading ||
    isTeamAdminLoading ||
    isSessionLoading ||
    (!!canReadTeams && teamsLoading);

  if (!catalog) return { canModify: false, isLoading };
  if (isAdmin) return { canModify: true, isLoading };

  const currentUserId = session?.user?.id;
  if (catalog.scope === "personal") {
    return {
      canModify: !!currentUserId && catalog.authorId === currentUserId,
      isLoading,
    };
  }
  if (catalog.scope === "team" && isTeamAdmin) {
    const userTeamIdSet = new Set((userTeams ?? []).map((t) => t.id));
    return {
      canModify: !!catalog.teams?.some((t) => userTeamIdSet.has(t.id)),
      isLoading,
    };
  }
  return { canModify: false, isLoading };
}
