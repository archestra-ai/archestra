import { MEMBER_ROLE_NAME } from "@shared";
import { eq } from "drizzle-orm";
import db, { schema } from "@/database";
import logger from "@/logging";
import type {
  BetterAuthSession,
  BetterAuthSessionUser,
  UpdateInvitation,
} from "@/types";
import MemberModel from "./member";
import SessionModel from "./session";
import UserTokenModel from "./user-token";

class InvitationModel {
  /**
   * Get an invitation by its ID
   */
  static async getById(invitationId: string) {
    logger.debug(
      { invitationId },
      "InvitationModel.getById: fetching invitation",
    );
    const [invitation] = await db
      .select()
      .from(schema.invitationsTable)
      .where(eq(schema.invitationsTable.id, invitationId))
      .limit(1);
    logger.debug(
      { invitationId, found: !!invitation },
      "InvitationModel.getById: completed",
    );
    return invitation;
  }

  /**
   * Find all invitations for a given email address (case-insensitive)
   * Used to auto-accept pending invitations on sign-in
   */
  static async findByEmail(email: string) {
    logger.debug(
      { email },
      "InvitationModel.findByEmail: fetching invitations",
    );
    const invitations = await db
      .select()
      .from(schema.invitationsTable)
      .where(eq(schema.invitationsTable.email, email.toLowerCase()));
    logger.debug(
      { email, count: invitations.length },
      "InvitationModel.findByEmail: completed",
    );
    return invitations;
  }

  /**
   * Find the first pending invitation for an email address
   */
  static async findPendingByEmail(email: string) {
    logger.debug(
      { email },
      "InvitationModel.findPendingByEmail: fetching pending invitation",
    );
    const invitations = await InvitationModel.findByEmail(email);
    const pending = invitations.find((inv) => inv.status === "pending");
    logger.debug(
      { email, found: !!pending },
      "InvitationModel.findPendingByEmail: completed",
    );
    return pending;
  }

  /**
   * Handle invitation sign-up
   *
   * Accept invitation and add user to organization
   */
  static async accept(
    { id: sessionId }: BetterAuthSession,
    user: BetterAuthSessionUser,
    invitationId: string,
  ) {
    logger.debug(
      { sessionId, userId: user.id, invitationId },
      "InvitationModel.accept: processing invitation",
    );
    logger.info(
      `🔗 Processing invitation ${invitationId} for user ${user.email}`,
    );

    try {
      const invitation = await InvitationModel.getById(invitationId);

      if (!invitation) {
        logger.error(`❌ Invitation ${invitationId} not found`);
        return;
      }

      const { organizationId, role: specifiedRole } = invitation;
      const role = specifiedRole || MEMBER_ROLE_NAME;

      // Create member row linking user to organization
      await MemberModel.create(user.id, organizationId, role);

      // Create personal token for the new member
      try {
        await UserTokenModel.ensureUserToken(user.id, organizationId);
        logger.info(
          `🔑 Personal token created for user ${user.email} in organization ${organizationId}`,
        );
      } catch (tokenError) {
        logger.error(
          { err: tokenError },
          `❌ Failed to create personal token for user ${user.email}:`,
        );
        // Don't fail invitation acceptance if token creation fails
      }

      // Mark invitation as accepted
      await InvitationModel.patch(invitationId, { status: "accepted" });

      // Set the organization as active in the session
      await SessionModel.patch(sessionId, {
        activeOrganizationId: organizationId,
      });

      logger.info(
        `✅ Invitation accepted: user ${user.email} added to organization ${organizationId} as ${role}`,
      );
      logger.debug(
        { invitationId, organizationId, role },
        "InvitationModel.accept: completed successfully",
      );
    } catch (error) {
      logger.error(
        { err: error },
        `❌ Failed to accept invitation ${invitationId}:`,
      );
    }
  }

  /**
   * Update an invitation with partial data
   */
  static async patch(invitationId: string, data: Partial<UpdateInvitation>) {
    logger.debug(
      { invitationId, data },
      "InvitationModel.patch: updating invitation",
    );
    const result = await db
      .update(schema.invitationsTable)
      .set(data)
      .where(eq(schema.invitationsTable.id, invitationId));
    logger.debug({ invitationId }, "InvitationModel.patch: completed");
    return result;
  }

  /**
   * Delete an invitation by its ID
   */
  static async delete(invitationId: string) {
    logger.debug(
      { invitationId },
      "InvitationModel.delete: deleting invitation",
    );
    const result = await db
      .delete(schema.invitationsTable)
      .where(eq(schema.invitationsTable.id, invitationId));
    logger.debug({ invitationId }, "InvitationModel.delete: completed");
    return result;
  }
}

export default InvitationModel;
