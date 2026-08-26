import { syncSystemRoleWithOrgPermissions } from "@/auth/system-role-sync";
import logger from "@/logging";
import {
  AccountModel,
  InvitationModel,
  McpServerModel,
  MemberModel,
  SkillMarketplaceCredentialModel,
  UserModel,
  UserTokenModel,
} from "@/models";
import { purgePersonalAppsForUser } from "@/services/apps/app-mcp-backing";

type MemberRemovalTarget =
  | { kind: "member"; id: string }
  | { kind: "pendingSignup"; id: string };

type MemberRemovalResult =
  | { status: "removed" }
  | { status: "not_found" }
  | { status: "self" }
  | { status: "classification_changed" };

/**
 * Removes one currently classified organization member. The target kind is
 * rechecked immediately before mutation so an accepted signup cannot be
 * treated as a pending placeholder, or vice versa.
 */
export async function removeMemberTarget(params: {
  organizationId: string;
  actorUserId?: string;
  target: MemberRemovalTarget;
}): Promise<MemberRemovalResult> {
  const { organizationId, target } = params;
  const member =
    target.kind === "member"
      ? await MemberModel.findByIdInOrganization(target.id, organizationId)
      : await MemberModel.getByUserId(target.id, organizationId);

  if (!member) return { status: "not_found" };

  if (member.userId === params.actorUserId) return { status: "self" };

  const account = await AccountModel.getByUserId(member.userId);
  const isAccepted = Boolean(account);
  if ((target.kind === "member") !== isAccepted) {
    return { status: "classification_changed" };
  }

  const pendingUser =
    target.kind === "pendingSignup"
      ? await UserModel.getById(member.userId)
      : null;
  if (target.kind === "pendingSignup" && !pendingUser) {
    return { status: "not_found" };
  }

  const deleted = await MemberModel.deleteClassifiedByUserInOrganization({
    userId: member.userId,
    organizationId,
    accepted: target.kind === "member",
  });
  if (deleted.length === 0) return { status: "classification_changed" };

  try {
    await UserTokenModel.deleteByUserAndOrg(member.userId, organizationId);
  } catch (err) {
    logger.error(
      { err, userId: member.userId, organizationId },
      "[member-removal] failed post-removal token cleanup",
    );
  }
  if (pendingUser) {
    try {
      // Email is not globally unique. Limit invitation deletion to this org.
      await InvitationModel.deleteAutoProvisionedByEmailInOrganization({
        email: pendingUser.email,
        organizationId,
      });
    } catch (err) {
      logger.error(
        { err, userId: member.userId, organizationId },
        "[member-removal] failed post-removal invitation cleanup",
      );
    }
  }

  try {
    await syncSystemRoleWithOrgPermissions(member.userId, organizationId);
  } catch (err) {
    logger.error(
      { err, userId: member.userId, organizationId },
      "[member-removal] failed to sync system role after membership removal",
    );
  }
  const accountAfterRemoval = await AccountModel.getByUserId(member.userId);
  await cleanupAfterMembershipRemoval({
    userId: member.userId,
    organizationId,
    deleteUserIfNoMemberships: !accountAfterRemoval || target.kind === "member",
  });
  return { status: "removed" };
}

/**
 * Cleans up resources that exist only because a user belonged to an
 * organization. The membership must already be gone when this runs.
 */
export async function cleanupAfterMembershipRemoval(params: {
  userId: string;
  organizationId: string;
  deleteUserIfNoMemberships?: boolean;
}): Promise<void> {
  const { userId, organizationId } = params;
  try {
    await purgePersonalAppsForUser({ userId, organizationId });
    await McpServerModel.purgePersonalServersForUserInOrganization(
      userId,
      organizationId,
    );
    await SkillMarketplaceCredentialModel.deleteForMember({
      userId,
      organizationId,
    });
    // Known micro-race, accepted: a membership created between this check and
    // the delete would be cascaded away. The window is a few milliseconds, the
    // failure mode is bounded and recoverable (re-invite the user), and
    // closing it would force the transaction-scoped purge variant, which
    // cannot tear down K8s deployments or Vault-backed secrets — a worse
    // everyday trade than the race.
    if (
      params.deleteUserIfNoMemberships !== false &&
      !(await MemberModel.hasAnyMembership(userId))
    ) {
      await UserModel.delete(userId);
    }
  } catch (err) {
    logger.error(
      { err, userId, organizationId },
      "[member-removal] failed to clean up personal resources after membership removal",
    );
  }
}
