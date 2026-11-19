import type { FastifyRequest } from "fastify";
import { hasPermission } from "@/auth";
import TeamModel from "@/models/team";
import { ApiError } from "@/types";

/**
 * The teams whose costs the caller may read: `teamIds` is undefined for the
 * whole organization. `llmCost:read` opens everything; without it, a signed-in
 * team admin reads the teams they administer and their sub-teams — the same
 * teams whose limits they can read — and `teamAdmin` is true.
 *
 * `teamId` narrows the result to one team, which must be among them.
 */
export async function getCostAccess(
  request: FastifyRequest,
  teamId?: string,
): Promise<{ teamIds: string[] | undefined; teamAdmin: boolean }> {
  const result = await hasPermission(
    { llmCost: ["read"] },
    request.headers,
    request.serviceAccount,
    {
      userId: request.user.id,
      organizationId: request.organizationId,
    },
  );
  if (result.success)
    return { teamIds: teamId ? [teamId] : undefined, teamAdmin: false };
  if (request.authMethod !== "session")
    throw new ApiError(
      403,
      "Team cost reporting requires a signed-in team admin.",
    );
  const teamIds = await TeamModel.getAdministeredTeamIds(
    request.user.id,
    request.organizationId,
  );
  if (!teamIds.length || (teamId && !teamIds.includes(teamId)))
    throw new ApiError(
      403,
      "You can only view costs for teams you administer.",
    );
  return { teamIds: teamId ? [teamId] : teamIds, teamAdmin: true };
}
