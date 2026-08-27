import { MemberModel, TeamModel } from "@/models";
import { ApiError } from "@/types";

/**
 * Shared plugin visibility validation, used by both the REST routes and the
 * plugin-management MCP tools. Team scopes reference teams of the same
 * organization; personal shares reference organization members.
 */
export async function validatePluginVisibility(params: {
  organizationId: string;
  scope: "personal" | "team" | "org";
  teamIds: string[];
  userIds: string[];
}): Promise<void> {
  if (params.scope === "team") {
    const teamIds = Array.from(new Set(params.teamIds));
    if (teamIds.length === 0) {
      throw new ApiError(400, "Team-visible plugins require at least one team");
    }
    const teams = await TeamModel.findByIds(teamIds);
    const validIds = new Set(
      teams
        .filter((team) => team.organizationId === params.organizationId)
        .map((team) => team.id),
    );
    const missing = teamIds.filter((id) => !validIds.has(id));
    if (missing.length > 0) {
      throw new ApiError(400, `Unknown team id(s): ${missing.join(", ")}`);
    }
  }
  if (params.scope === "personal" && params.userIds.length > 0) {
    const userIds = Array.from(new Set(params.userIds));
    const validIds = new Set(
      await MemberModel.findUserIdsInOrganization({
        organizationId: params.organizationId,
        userIds,
      }),
    );
    const missing = userIds.filter((id) => !validIds.has(id));
    if (missing.length > 0) {
      throw new ApiError(400, `Unknown user id(s): ${missing.join(", ")}`);
    }
  }
}
