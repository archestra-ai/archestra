import logger from "@/logging";
import { AgentModel, OrganizationModel, TeamModel } from "@/models";
import type { ToolCompressionStats } from "@/types";

export type { ToolCompressionStats };

/**
 * Determine if TOON compression should be applied based on organization/team settings
 */
export async function shouldApplyToonCompression(
  agentId: string,
): Promise<boolean> {
  const organizationId = await AgentModel.findOrganizationId(agentId);
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
