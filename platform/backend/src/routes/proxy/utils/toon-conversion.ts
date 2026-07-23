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

  // Organization-wide enablement compresses everything regardless of team flags
  if (
    organization.compressionScope === "organization" &&
    organization.convertToolResultsToToon
  ) {
    logger.info({ agentId }, "TOON compression: enabled organization-wide");
    return true;
  }

  // A team-level opt-in is honored regardless of the organization's
  // compression scope, so a stored team flag is never silently inert:
  // org-level settings act as the org-wide default, team flags as per-team
  // opt-ins on top.
  const profileTeams = await TeamModel.getTeamsForAgent(agentId);
  const shouldApply = profileTeams.some(
    (team) => team.convertToolResultsToToon,
  );
  logger.info(
    {
      agentId,
      compressionScope: organization.compressionScope,
      teamsCount: profileTeams.length,
      enabled: shouldApply,
    },
    "TOON compression: resolved from team-level flags",
  );
  return shouldApply;
}
