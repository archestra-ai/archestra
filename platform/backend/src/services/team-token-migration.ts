import { MEMBER_ROLE_NAME } from "@archestra/shared";
import logger from "@/logging";
import { ServiceAccountModel, TeamTokenModel } from "@/models";

/**
 * Move every organization and team gateway token onto a service account.
 *
 * A gateway call has to name who is acting; an organization or team token
 * named nobody. Each token becomes a key on its own service account and keeps
 * its exact value, so clients already configured with it keep working:
 * - a team token's account acts for that team, so the team's grants and the
 *   team's MCP connections still reach it;
 * - the organization token's account acts for nobody in particular, so it
 *   reaches what is shared with the whole organization — what the
 *   organization token reached.
 *
 * Runs on every startup. A token whose value already belongs to a service
 * account is skipped, so re-runs are no-ops.
 */
export async function migrateTeamTokensToServiceAccounts(): Promise<void> {
  const tokens = await TeamTokenModel.findAllWithTeam();
  let migrated = 0;
  for (const token of tokens) {
    const value = await TeamTokenModel.getTokenValue(token.id);
    if (!value) {
      logger.warn(
        { tokenId: token.id },
        "Team token has no readable value; skipping migration to a service account",
      );
      continue;
    }
    if (await ServiceAccountModel.isTokenImported(value)) continue;

    const teamName = token.isOrganizationToken ? null : token.team?.name;
    if (!token.isOrganizationToken && !teamName) continue;

    const serviceAccount = await ServiceAccountModel.create({
      organizationId: token.organizationId,
      name: await availableName({
        organizationId: token.organizationId,
        base: teamName ? `Team token: ${teamName}` : "Organization token",
        suffix: token.id.slice(0, 8),
      }),
      role: MEMBER_ROLE_NAME,
      teamId: token.isOrganizationToken ? null : token.teamId,
      createdBy: null,
    });
    await ServiceAccountModel.importToken({
      serviceAccountId: serviceAccount.id,
      name: token.name,
      value,
      lastUsedAt: token.lastUsedAt,
      createdAt: token.createdAt,
    });
    migrated++;
  }
  if (migrated > 0) {
    logger.info(
      { migrated },
      "Moved organization and team gateway tokens onto service accounts",
    );
  }
}

// === Internal helpers

async function availableName(params: {
  organizationId: string;
  base: string;
  suffix: string;
}): Promise<string> {
  const taken = await ServiceAccountModel.isNameTaken(
    params.organizationId,
    params.base,
  );
  return taken ? `${params.base} (${params.suffix})` : params.base;
}
