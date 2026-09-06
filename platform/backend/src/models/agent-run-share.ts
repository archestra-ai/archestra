import { and, eq } from "drizzle-orm";
import db, { schema, withDbTransaction } from "@/database";
import type {
  AgentRunShare,
  AgentRunShareVisibility,
  AgentRunShareWithTargets,
} from "@/types";
import TeamModel from "./team";

class AgentRunShareModel {
  static async findByTaskId(params: {
    taskId: string;
    organizationId: string;
  }): Promise<AgentRunShareWithTargets | null> {
    const [share] = await db
      .select()
      .from(schema.agentRunSharesTable)
      .where(
        and(
          eq(schema.agentRunSharesTable.taskId, params.taskId),
          eq(schema.agentRunSharesTable.organizationId, params.organizationId),
        ),
      )
      .limit(1);

    if (!share) {
      return null;
    }

    return AgentRunShareModel.attachTargets(share);
  }

  static async findAccessibleByTaskId(params: {
    taskId: string;
    organizationId: string;
    userId: string;
  }): Promise<AgentRunShareWithTargets | null> {
    const share = await AgentRunShareModel.findByTaskId({
      taskId: params.taskId,
      organizationId: params.organizationId,
    });

    if (!share) {
      return null;
    }

    const canAccess = await AgentRunShareModel.userCanAccessShare({
      share,
      userId: params.userId,
    });

    return canAccess ? share : null;
  }

  static async findByShareId(params: {
    shareId: string;
    organizationId: string;
  }): Promise<AgentRunShareWithTargets | null> {
    const [share] = await db
      .select()
      .from(schema.agentRunSharesTable)
      .where(
        and(
          eq(schema.agentRunSharesTable.id, params.shareId),
          eq(schema.agentRunSharesTable.organizationId, params.organizationId),
        ),
      )
      .limit(1);

    if (!share) {
      return null;
    }

    return AgentRunShareModel.attachTargets(share);
  }

  static async upsert(params: {
    taskId: string;
    organizationId: string;
    createdByUserId: string;
    visibility: AgentRunShareVisibility;
    teamIds: string[];
    userIds: string[];
  }): Promise<AgentRunShareWithTargets> {
    // Caller must verify the requesting user owns the execution before updating
    // share state for it. This model only enforces org/task identity, not run
    // ownership.
    const shareId = await withDbTransaction(async (tx) => {
      const [existing] = await tx
        .select()
        .from(schema.agentRunSharesTable)
        .where(
          and(
            eq(schema.agentRunSharesTable.taskId, params.taskId),
            eq(
              schema.agentRunSharesTable.organizationId,
              params.organizationId,
            ),
          ),
        )
        .limit(1);

      const [share] = existing
        ? await tx
            .update(schema.agentRunSharesTable)
            .set({
              visibility: params.visibility,
              createdByUserId: params.createdByUserId,
            })
            .where(eq(schema.agentRunSharesTable.id, existing.id))
            .returning()
        : await tx
            .insert(schema.agentRunSharesTable)
            .values({
              taskId: params.taskId,
              organizationId: params.organizationId,
              createdByUserId: params.createdByUserId,
              visibility: params.visibility,
            })
            .returning();

      await tx
        .delete(schema.agentRunShareTeamsTable)
        .where(eq(schema.agentRunShareTeamsTable.shareId, share.id));
      await tx
        .delete(schema.agentRunShareUsersTable)
        .where(eq(schema.agentRunShareUsersTable.shareId, share.id));

      if (params.teamIds.length > 0) {
        await tx.insert(schema.agentRunShareTeamsTable).values(
          params.teamIds.map((teamId) => ({
            shareId: share.id,
            teamId,
          })),
        );
      }

      if (params.userIds.length > 0) {
        await tx.insert(schema.agentRunShareUsersTable).values(
          params.userIds.map((userId) => ({
            shareId: share.id,
            userId,
          })),
        );
      }

      return share.id;
    });

    const updatedShare = await AgentRunShareModel.findByShareId({
      shareId,
      organizationId: params.organizationId,
    });

    if (!updatedShare) {
      throw new Error("Failed to load agent run share after update");
    }

    return updatedShare;
  }

  static async delete(params: {
    taskId: string;
    organizationId: string;
    userId: string;
  }): Promise<boolean> {
    const result = await db
      .delete(schema.agentRunSharesTable)
      .where(
        and(
          eq(schema.agentRunSharesTable.taskId, params.taskId),
          eq(schema.agentRunSharesTable.organizationId, params.organizationId),
          eq(schema.agentRunSharesTable.createdByUserId, params.userId),
        ),
      )
      .returning();

    return result.length > 0;
  }

  static async userCanAccessShare(params: {
    share: AgentRunShareWithTargets;
    userId: string;
  }): Promise<boolean> {
    if (params.share.createdByUserId === params.userId) {
      return true;
    }

    if (params.share.visibility === "organization") {
      return true;
    }

    if (params.share.visibility === "user") {
      return params.share.userIds.includes(params.userId);
    }

    if (params.share.visibility === "team") {
      if (params.share.teamIds.length === 0) {
        return false;
      }

      const userTeamIds = new Set(
        await TeamModel.getUserTeamIds(params.userId),
      );

      return params.share.teamIds.some((teamId) => userTeamIds.has(teamId));
    }

    return false;
  }

  private static async attachTargets(
    share: AgentRunShare,
  ): Promise<AgentRunShareWithTargets> {
    const [teams, users] = await Promise.all([
      db
        .select({ teamId: schema.agentRunShareTeamsTable.teamId })
        .from(schema.agentRunShareTeamsTable)
        .where(eq(schema.agentRunShareTeamsTable.shareId, share.id)),
      db
        .select({ userId: schema.agentRunShareUsersTable.userId })
        .from(schema.agentRunShareUsersTable)
        .where(eq(schema.agentRunShareUsersTable.shareId, share.id)),
    ]);

    return {
      ...share,
      teamIds: teams.map((row) => row.teamId),
      userIds: users.map((row) => row.userId),
    };
  }
}

export default AgentRunShareModel;
