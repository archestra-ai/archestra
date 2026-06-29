import logger from "@/logging";
import { AgentTeamModel, OrganizationModel, TeamModel } from "@/models";
import type { ToolCompressionStats } from "@/types";

export type { ToolCompressionStats };

/**
 * Determine if TOON compression should be applied based on organization/team settings
 * Follows the same pattern as cost optimization: uses agent's teams or fallback to first org
 */
export async function shouldApplyToonCompression(
  agentId: string,
): Promise<boolean> {
  // Get organizationId the same way cost optimization does: from agent's teams OR fallback
  let organizationId: string | null = null;
  const agentTeamIds = await AgentTeamModel.getTeamsForAgent(agentId);

  if (agentTeamIds.length > 0) {
    // Get organizationId from agent's first team
    const teams = await TeamModel.findByIds(agentTeamIds);
    if (teams.length > 0 && teams[0].organizationId) {
      organizationId = teams[0].organizationId;
      logger.info(
        { agentId, organizationId },
        "TOON compression: resolved organizationId from team",
      );
    }
  } else {
    // If agent has no teams, use fallback to first organization in database
    const firstOrg = await OrganizationModel.getFirst();

    if (firstOrg) {
      organizationId = firstOrg.id;
      logger.info(
        { agentId, organizationId },
        "TOON compression: agent has no teams - using fallback organization",
      );
    }
  }

  if (!organizationId) {
    logger.warn(
      { agentId },
      "TOON compression: could not resolve organizationId",
    );
    return false;
  }

  // Fetch the organization to get compression settings
  const organization = await OrganizationModel.getById(organizationId);
  if (!organization) {
    logger.warn(
      { agentId, organizationId },
      "TOON compression: organization not found",
    );
    return false;
  }

  // Check compression scope and determine if TOON should be applied
  if (organization.compressionScope === "organization") {
    logger.info(
      { agentId, enabled: organization.convertToolResultsToToon },
      "TOON compression: organization-level scope",
    );
    return organization.convertToolResultsToToon;
  }

  if (organization.compressionScope === "team") {
    // Team-level: check if ANY of the profile's teams have compression enabled
    const profileTeams = await TeamModel.getTeamsForAgent(agentId);
    const shouldApply = profileTeams.some(
      (team) => team.convertToolResultsToToon,
    );
    logger.info(
      { agentId, teamsCount: profileTeams.length, enabled: shouldApply },
      "TOON compression: team-level scope",
    );
    return shouldApply;
  }

  // Default: compression disabled
  logger.info({ agentId }, "TOON compression: disabled (no scope configured)");
  return false;
}
