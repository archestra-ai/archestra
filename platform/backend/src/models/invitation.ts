import {
  AUTO_PROVISIONED_INVITATION_STATUS,
  MEMBER_ROLE_NAME,
} from "@archestra/shared";
import { and, eq, inArray, like } from "drizzle-orm";
import db, { schema, type Transaction } from "@/database";
import logger from "@/logging";
import type {
  BetterAuthSession,
  BetterAuthSessionUser,
  UpdateInvitation,
} from "@/types";
import AgentModel from "./agent";
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

  static async findAutoProvisionedByEmailsInOrg(params: {
    emails: string[];
    organizationId: string;
    tx?: Transaction;
  }) {
    const uniqueEmails = [...new Set(params.emails)];
    if (uniqueEmails.length === 0) return [];

    logger.debug(
      {
        organizationId: params.organizationId,
        emailCount: uniqueEmails.length,
      },
      "InvitationModel.findAutoProvisionedByEmailsInOrg: fetching invitations",
    );

    const dbOrTx = params.tx ?? db;
    const invitations = await dbOrTx
      .select({
        id: schema.invitationsTable.id,
        email: schema.invitationsTable.email,
        status: schema.invitationsTable.status,
      })
      .from(schema.invitationsTable)
      .where(
        and(
          eq(schema.invitationsTable.organizationId, params.organizationId),
          inArray(schema.invitationsTable.email, uniqueEmails),
          like(
            schema.invitationsTable.status,
            `${AUTO_PROVISIONED_INVITATION_STATUS}%`,
          ),
        ),
      );

    logger.debug(
      { organizationId: params.organizationId, count: invitations.length },
      "InvitationModel.findAutoProvisionedByEmailsInOrg: completed",
    );
    return invitations;
  }

  static async deleteAutoProvisionedForEmailInOrg(params: {
    email: string;
    organizationId: string;
    tx?: Transaction;
  }): Promise<number> {
    logger.debug(
      { email: params.email, organizationId: params.organizationId },
      "InvitationModel.deleteAutoProvisionedForEmailInOrg: deleting invitations",
    );

    const dbOrTx = params.tx ?? db;
    const deleted = await dbOrTx
      .delete(schema.invitationsTable)
      .where(
        and(
          eq(schema.invitationsTable.email, params.email),
          eq(schema.invitationsTable.organizationId, params.organizationId),
          like(
            schema.invitationsTable.status,
            `${AUTO_PROVISIONED_INVITATION_STATUS}%`,
          ),
        ),
      )
      .returning({ id: schema.invitationsTable.id });

    logger.debug(
      {
        email: params.email,
        organizationId: params.organizationId,
        count: deleted.length,
      },
      "InvitationModel.deleteAutoProvisionedForEmailInOrg: completed",
    );
    return deleted.length;
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

      // The member table has no unique constraint on (userId, organizationId),
      // so a blind insert here would silently create a duplicate row when the
      // user is already a member of this org. With duplicates, getByUserId's
      // .limit(1) returns either row non-deterministically — an admin can
      // appear as a member on the next sign-in, breaking permission checks.
      const existingMember = await MemberModel.getByUserId(
        user.id,
        organizationId,
      );

      if (!existingMember) {
        await MemberModel.create(user.id, organizationId, role);
      }

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

      // Create personal default chat agent for the new member
      try {
        await AgentModel.ensurePersonalChatAgent({
          userId: user.id,
          organizationId,
        });
      } catch (agentError) {
        logger.error(
          { err: agentError },
          `❌ Failed to create personal chat agent for user ${user.email}:`,
        );
      }

      // Create personal MCP gateway for the new member
      try {
        await AgentModel.ensurePersonalMcpGateway({
          userId: user.id,
          organizationId,
        });
      } catch (gatewayError) {
        logger.error(
          { err: gatewayError },
          `❌ Failed to create personal MCP gateway for user ${user.email}:`,
        );
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

  static async findByIdForAudit(
    id: string,
    organizationId: string,
  ): Promise<Record<string, unknown> | null> {
    const [row] = await db
      .select()
      .from(schema.invitationsTable)
      .where(
        and(
          eq(schema.invitationsTable.id, id),
          eq(schema.invitationsTable.organizationId, organizationId),
        ),
      )
      .limit(1);

    if (!row) return null;

    return {
      id: row.id,
      organizationId: row.organizationId,
      email: row.email,
      role: row.role ?? null,
      status: row.status,
      inviterId: row.inviterId,
      expiresAt: row.expiresAt.toISOString(),
      createdAt: row.createdAt.toISOString(),
    };
  }
}

export default InvitationModel;
