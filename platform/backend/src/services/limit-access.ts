import type { FastifyRequest } from "fastify";
import { hasPermission } from "@/auth/utils";
import TeamModel from "@/models/team";
import { ApiError } from "@/types";

type LimitAction = "read" | "create" | "update" | "delete";

/** Organization permissions retain their reach; direct team admins manage only their teams. */
export async function getLimitAccess(
  request: FastifyRequest,
  action: LimitAction,
): Promise<string[] | undefined> {
  const result = await hasPermission(
    { llmLimit: [action] },
    request.headers,
    request.serviceAccount,
    {
      userId: request.user.id,
      organizationId: request.organizationId,
    },
  );
  if (result.success) return undefined;
  if (request.authMethod !== "session")
    throw new ApiError(
      403,
      "Team limit management requires a signed-in team admin.",
    );
  const teamIds = await TeamModel.getUserAdminTeamIds(
    request.user.id,
    request.organizationId,
  );
  if (!teamIds.length)
    throw new ApiError(
      403,
      "You can only manage limits for teams you administer.",
    );
  return teamIds;
}

/** Team admins change only the limits they created, not ones the organization set. */
export function assertCanChangeLimit(
  teamIds: string[] | undefined,
  limit: { teamManaged: boolean },
): void {
  if (teamIds && !limit.teamManaged) {
    throw new ApiError(
      403,
      "Your organization set this limit. Ask someone who manages organization limits to change it.",
    );
  }
}

export function assertLimitTarget(
  teamIds: string[] | undefined,
  limit: { entityType: string; entityId: string },
): void {
  if (
    teamIds &&
    (limit.entityType !== "team" || !teamIds.includes(limit.entityId))
  ) {
    throw new ApiError(404, "Limit not found");
  }
}
