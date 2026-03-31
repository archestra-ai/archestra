import { and, eq } from "drizzle-orm";
import db, { schema } from "@/database";
import type {
  Conversation,
  ConversationShare,
  ConversationShareVisibility,
  ConversationShareWithTargets,
} from "@/types";

class ConversationShareModel {
  static async findByConversationId(params: {
    conversationId: string;
    organizationId: string;
  }): Promise<ConversationShareWithTargets | null> {
    const [share] = await db
      .select()
      .from(schema.conversationSharesTable)
      .where(
        and(
          eq(
            schema.conversationSharesTable.conversationId,
            params.conversationId,
          ),
          eq(
            schema.conversationSharesTable.organizationId,
            params.organizationId,
          ),
        ),
      )
      .limit(1);

    if (!share) {
      return null;
    }

    return ConversationShareModel.attachTargets(share);
  }

  static async findByShareId(params: {
    shareId: string;
    organizationId: string;
  }): Promise<ConversationShareWithTargets | null> {
    const [share] = await db
      .select()
      .from(schema.conversationSharesTable)
      .where(
        and(
          eq(schema.conversationSharesTable.id, params.shareId),
          eq(
            schema.conversationSharesTable.organizationId,
            params.organizationId,
          ),
        ),
      )
      .limit(1);

    if (!share) {
      return null;
    }

    return ConversationShareModel.attachTargets(share);
  }

  static async upsert(params: {
    conversationId: string;
    organizationId: string;
    createdByUserId: string;
    visibility: ConversationShareVisibility;
    teamIds: string[];
    userIds: string[];
  }): Promise<ConversationShareWithTargets> {
    const shareId = await db.transaction(async (tx) => {
      const [existing] = await tx
        .select()
        .from(schema.conversationSharesTable)
        .where(
          and(
            eq(
              schema.conversationSharesTable.conversationId,
              params.conversationId,
            ),
            eq(
              schema.conversationSharesTable.organizationId,
              params.organizationId,
            ),
          ),
        )
        .limit(1);

      const [share] = existing
        ? await tx
            .update(schema.conversationSharesTable)
            .set({
              visibility: params.visibility,
              createdByUserId: params.createdByUserId,
            })
            .where(eq(schema.conversationSharesTable.id, existing.id))
            .returning()
        : await tx
            .insert(schema.conversationSharesTable)
            .values({
              conversationId: params.conversationId,
              organizationId: params.organizationId,
              createdByUserId: params.createdByUserId,
              visibility: params.visibility,
            })
            .returning();

      await tx
        .delete(schema.conversationShareTeamsTable)
        .where(eq(schema.conversationShareTeamsTable.shareId, share.id));
      await tx
        .delete(schema.conversationShareUsersTable)
        .where(eq(schema.conversationShareUsersTable.shareId, share.id));

      if (params.teamIds.length > 0) {
        await tx.insert(schema.conversationShareTeamsTable).values(
          params.teamIds.map((teamId) => ({
            shareId: share.id,
            teamId,
          })),
        );
      }

      if (params.userIds.length > 0) {
        await tx.insert(schema.conversationShareUsersTable).values(
          params.userIds.map((userId) => ({
            shareId: share.id,
            userId,
          })),
        );
      }

      return share.id;
    });

    const updatedShare = await ConversationShareModel.findByShareId({
      shareId,
      organizationId: params.organizationId,
    });

    if (!updatedShare) {
      throw new Error("Failed to load conversation share after update");
    }

    return updatedShare;
  }

  static async delete(params: {
    conversationId: string;
    organizationId: string;
    userId: string;
  }): Promise<boolean> {
    const result = await db
      .delete(schema.conversationSharesTable)
      .where(
        and(
          eq(
            schema.conversationSharesTable.conversationId,
            params.conversationId,
          ),
          eq(
            schema.conversationSharesTable.organizationId,
            params.organizationId,
          ),
          eq(schema.conversationSharesTable.createdByUserId, params.userId),
        ),
      )
      .returning();

    return result.length > 0;
  }

  /**
   * Get a shared conversation with messages for viewing.
   * Access is limited by the share scope and target assignments.
   */
  static async getSharedConversation(params: {
    shareId: string;
    organizationId: string;
    userId: string;
  }): Promise<(Conversation & { sharedByUserId: string }) | null> {
    const share = await ConversationShareModel.findByShareId(params);
    if (!share || !(await ConversationShareModel.userCanAccessShare(params))) {
      return null;
    }

    const rows = await db
      .select({
        conversation: schema.conversationsTable,
        message: schema.messagesTable,
        agent: schema.agentsTable,
      })
      .from(schema.conversationsTable)
      .leftJoin(
        schema.agentsTable,
        eq(schema.conversationsTable.agentId, schema.agentsTable.id),
      )
      .leftJoin(
        schema.messagesTable,
        eq(schema.conversationsTable.id, schema.messagesTable.conversationId),
      )
      .where(eq(schema.conversationsTable.id, share.conversationId))
      .orderBy(schema.messagesTable.createdAt);

    if (rows.length === 0) return null;

    const firstRow = rows[0];
    const messages = [];

    for (const row of rows) {
      if (row.message?.content) {
        messages.push({
          ...row.message.content,
          id: row.message.id,
        });
      }
    }

    return {
      ...firstRow.conversation,
      agent: firstRow.agent,
      messages,
      sharedByUserId: share.createdByUserId,
    };
  }

  static async userCanAccessShare(params: {
    shareId: string;
    organizationId: string;
    userId: string;
  }): Promise<boolean> {
    const share = await ConversationShareModel.findByShareId(params);

    if (!share) {
      return false;
    }

    if (share.createdByUserId === params.userId) {
      return true;
    }

    if (share.visibility === "organization") {
      return true;
    }

    if (share.visibility === "user") {
      return share.userIds.includes(params.userId);
    }

    if (share.teamIds.length === 0) {
      return false;
    }

    const memberships = await db
      .select({ teamId: schema.teamMembersTable.teamId })
      .from(schema.teamMembersTable)
      .where(eq(schema.teamMembersTable.userId, params.userId));

    const userTeamIds = new Set(memberships.map((membership) => membership.teamId));

    return share.teamIds.some((teamId) => userTeamIds.has(teamId));
  }

  private static async attachTargets(
    share: ConversationShare,
  ): Promise<ConversationShareWithTargets> {
    const params = { share };
    const [teams, users] = await Promise.all([
      db
        .select({ teamId: schema.conversationShareTeamsTable.teamId })
        .from(schema.conversationShareTeamsTable)
        .where(eq(schema.conversationShareTeamsTable.shareId, params.share.id)),
      db
        .select({ userId: schema.conversationShareUsersTable.userId })
        .from(schema.conversationShareUsersTable)
        .where(eq(schema.conversationShareUsersTable.shareId, params.share.id)),
    ]);

    return {
      ...params.share,
      teamIds: teams.map((row) => row.teamId),
      userIds: users.map((row) => row.userId),
    };
  }
}

export default ConversationShareModel;
