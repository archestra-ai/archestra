import logger from "@/logging";
import {
  AgentModel,
  MemberModel,
  OrganizationModel,
  UserModel,
} from "@/models";

/**
 * Create a member who has not signed up yet: a `user` row with no `account`
 * row, a `member` row with the organization's default role and no team, and
 * the member's personal chat agent and MCP gateway.
 *
 * The member can be added to teams right away. Their first SSO sign-in with
 * the same email links onto this user, so the teams stay.
 *
 * Throws the unique-constraint error when a user with this email exists.
 */
export async function createPendingSignupMember(params: {
  organizationId: string;
  email: string;
  name: string;
  /** Marks the user as created by SCIM provisioning (`user.scim_provisioned`). */
  scimProvisioned?: boolean;
}): Promise<{ userId: string; role: string }> {
  const { organizationId } = params;
  const role = await OrganizationModel.getDefaultMemberRole(organizationId);
  const user = await UserModel.createWithoutAccount({
    name: params.name,
    email: params.email,
    scimProvisioned: params.scimProvisioned,
  });
  try {
    await MemberModel.create(user.id, organizationId, role);
  } catch (error) {
    // A user with no member row is on no page and keeps the email taken, so
    // the next attempt would fail as a duplicate. Remove it and report the
    // original failure.
    await UserModel.delete(user.id).catch((cleanupError) =>
      logger.error(
        { err: cleanupError, userId: user.id },
        "[pending-signup-member] Failed to remove the user after its member could not be created",
      ),
    );
    throw error;
  }

  try {
    await AgentModel.ensurePersonalChatAgent({
      userId: user.id,
      organizationId,
    });
  } catch (error) {
    logger.error(
      { err: error, userId: user.id },
      "[pending-signup-member] Failed to create personal chat agent",
    );
  }
  try {
    await AgentModel.ensurePersonalMcpGateway({
      userId: user.id,
      organizationId,
    });
  } catch (error) {
    logger.error(
      { err: error, userId: user.id },
      "[pending-signup-member] Failed to create personal MCP gateway",
    );
  }

  return { userId: user.id, role };
}
