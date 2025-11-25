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

class InvitationModel {
  static async getById(invitationId: string) {
    const [invitation] = await db
      .select()
      .from(schema.invitationsTable)
      .where(eq(schema.invitationsTable.id, invitationId))
      .limit(1);

    return invitation;
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

      // Mark invitation as accepted
      await InvitationModel.patch(invitationId, { status: "accepted" });

      // Set the organization as active in the session
      await SessionModel.patch(sessionId, {
        activeOrganizationId: organizationId,
      });

      logger.info(
        `✅ Invitation accepted: user ${user.email} added to organization ${organizationId} as ${role}`,
      );
    } catch (error) {
      logger.error(
        { err: error },
        `❌ Failed to accept invitation ${invitationId}:`,
      );
    }
  }

  static async patch(invitationId: string, data: Partial<UpdateInvitation>) {
    return await db
      .update(schema.invitationsTable)
      .set(data)
      .where(eq(schema.invitationsTable.id, invitationId));
  }

  static async delete(invitationId: string) {
    return await db
      .delete(schema.invitationsTable)
      .where(eq(schema.invitationsTable.id, invitationId));
  }
}

export default InvitationModel;
