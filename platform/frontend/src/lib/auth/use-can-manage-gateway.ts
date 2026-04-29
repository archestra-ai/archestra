import { archestraApiSdk, type archestraApiTypes } from "@shared";
import { useQuery } from "@tanstack/react-query";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { authClient } from "@/lib/clients/auth/auth-client";

type Gateway = archestraApiTypes.GetAgentResponses["200"] | null | undefined;

/**
 * Mirrors the server-side authorization rule for mutating an Agent
 * (see backend/src/auth/agent-type-permissions.ts requireAgentModifyPermission):
 *   - personal scope: only the authorId may modify
 *   - team scope:     mcpGateway:team-admin AND member of one of the agent's teams
 *   - org scope:      mcpGateway:admin
 */
export function useCanManageGateway(gateway: Gateway): {
  canManage: boolean;
  isLoading: boolean;
} {
  const { data: isAdmin, isLoading: isAdminLoading } = useHasPermissions({
    mcpGateway: ["admin"],
  });
  const { data: isTeamAdmin, isLoading: isTeamAdminLoading } =
    useHasPermissions({ mcpGateway: ["team-admin"] });
  const { data: canReadTeams } = useHasPermissions({ team: ["read"] });

  const { data: session, isPending: isSessionLoading } =
    authClient.useSession();
  const currentUserId = session?.user?.id;

  const { data: userTeams, isLoading: isTeamsLoading } = useQuery({
    queryKey: ["teams"],
    queryFn: async () => {
      const { data } = await archestraApiSdk.getTeams({
        query: { limit: 100, offset: 0 },
      });
      return data?.data ?? [];
    },
    enabled: !!canReadTeams && gateway?.scope === "team",
  });

  const isLoading =
    isAdminLoading ||
    isTeamAdminLoading ||
    isSessionLoading ||
    (gateway?.scope === "team" && !!canReadTeams && isTeamsLoading);

  if (!gateway) return { canManage: false, isLoading };

  if (gateway.scope === "personal") {
    return {
      canManage: !!currentUserId && gateway.authorId === currentUserId,
      isLoading,
    };
  }

  if (gateway.scope === "team") {
    const userTeamIds = new Set((userTeams ?? []).map((t) => t.id));
    const isMember = gateway.teams?.some((t) => userTeamIds.has(t.id)) ?? false;
    return { canManage: !!isTeamAdmin && isMember, isLoading };
  }

  return { canManage: !!isAdmin, isLoading };
}
