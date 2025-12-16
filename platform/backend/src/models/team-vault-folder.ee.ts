import { ADMIN_ROLE_NAME } from "@shared";
import { and, eq } from "drizzle-orm";
import db, { schema } from "@/database";
import logger from "@/logging";
import type { TeamVaultFolder } from "@/types";

class TeamVaultFolderModel {
  /**
   * Create or update a team's Vault folder mapping
   */
  static async upsert(
    teamId: string,
    vaultPath: string,
  ): Promise<TeamVaultFolder> {
    logger.debug(
      { teamId, vaultPath },
      "TeamVaultFolderModel.upsert: upserting team vault folder",
    );

    const now = new Date();
    const id = crypto.randomUUID();

    const [result] = await db
      .insert(schema.teamVaultFoldersTable)
      .values({
        id,
        teamId,
        vaultPath,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: schema.teamVaultFoldersTable.teamId,
        set: {
          vaultPath,
          updatedAt: now,
        },
      })
      .returning();

    logger.debug(
      { teamId, folderId: result.id },
      "TeamVaultFolderModel.upsert: completed",
    );
    return result;
  }

  /**
   * Find a team's Vault folder by team ID
   */
  static async findByTeamId(teamId: string): Promise<TeamVaultFolder | null> {
    logger.debug(
      { teamId },
      "TeamVaultFolderModel.findByTeamId: fetching team vault folder",
    );

    const [folder] = await db
      .select()
      .from(schema.teamVaultFoldersTable)
      .where(eq(schema.teamVaultFoldersTable.teamId, teamId))
      .limit(1);

    if (!folder) {
      logger.debug(
        { teamId },
        "TeamVaultFolderModel.findByTeamId: folder not found",
      );
      return null;
    }

    logger.debug(
      { teamId, folderId: folder.id },
      "TeamVaultFolderModel.findByTeamId: completed",
    );
    return folder;
  }

  /**
   * Delete a team's Vault folder mapping
   */
  static async delete(teamId: string): Promise<boolean> {
    logger.debug(
      { teamId },
      "TeamVaultFolderModel.delete: deleting team vault folder",
    );

    // First check if the folder exists
    const existing = await TeamVaultFolderModel.findByTeamId(teamId);
    if (!existing) {
      return false;
    }

    await db
      .delete(schema.teamVaultFoldersTable)
      .where(eq(schema.teamVaultFoldersTable.teamId, teamId));

    logger.debug({ teamId }, "TeamVaultFolderModel.delete: completed");
    return true;
  }

  /**
   * Get all Vault folders accessible to a user.
   * - Org admins can access all folders in the organization
   * - Team admins can access folders of teams they are admin of
   */
  static async getAccessibleFolders(
    userId: string,
    organizationId: string,
    isOrgAdmin: boolean,
  ): Promise<TeamVaultFolder[]> {
    logger.debug(
      { userId, organizationId, isOrgAdmin },
      "TeamVaultFolderModel.getAccessibleFolders: fetching accessible folders",
    );

    if (isOrgAdmin) {
      // Org admins can access all folders
      const folders = await db
        .select({
          folder: schema.teamVaultFoldersTable,
        })
        .from(schema.teamVaultFoldersTable)
        .innerJoin(
          schema.teamsTable,
          eq(schema.teamVaultFoldersTable.teamId, schema.teamsTable.id),
        )
        .where(eq(schema.teamsTable.organizationId, organizationId));

      logger.debug(
        { userId, count: folders.length },
        "TeamVaultFolderModel.getAccessibleFolders: completed (org admin)",
      );
      return folders.map((f) => f.folder);
    }

    // Get folders for teams where user is admin
    const folders = await db
      .select({
        folder: schema.teamVaultFoldersTable,
      })
      .from(schema.teamVaultFoldersTable)
      .innerJoin(
        schema.teamsTable,
        eq(schema.teamVaultFoldersTable.teamId, schema.teamsTable.id),
      )
      .innerJoin(
        schema.teamMembersTable,
        eq(schema.teamsTable.id, schema.teamMembersTable.teamId),
      )
      .where(
        and(
          eq(schema.teamMembersTable.userId, userId),
          eq(schema.teamMembersTable.role, ADMIN_ROLE_NAME),
          eq(schema.teamsTable.organizationId, organizationId),
        ),
      );

    logger.debug(
      { userId, count: folders.length },
      "TeamVaultFolderModel.getAccessibleFolders: completed (team admin)",
    );
    return folders.map((f) => f.folder);
  }

  /**
   * Check if a Vault path is accessible to a user based on their team folder mappings.
   * A path is accessible if it starts with one of the user's team folder paths.
   */
  static async isVaultPathAccessible(
    userId: string,
    organizationId: string,
    vaultPath: string,
    isOrgAdmin: boolean,
  ): Promise<boolean> {
    logger.debug(
      { userId, vaultPath, isOrgAdmin },
      "TeamVaultFolderModel.isVaultPathAccessible: checking path access",
    );

    const accessibleFolders = await TeamVaultFolderModel.getAccessibleFolders(
      userId,
      organizationId,
      isOrgAdmin,
    );

    // Check if the path starts with any of the accessible folder paths
    const hasAccess = accessibleFolders.some((folder) =>
      vaultPath.startsWith(folder.vaultPath),
    );

    logger.debug(
      { userId, vaultPath, hasAccess },
      "TeamVaultFolderModel.isVaultPathAccessible: completed",
    );
    return hasAccess;
  }
}

export default TeamVaultFolderModel;
