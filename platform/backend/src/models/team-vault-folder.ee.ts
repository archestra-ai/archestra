import { and, eq } from "drizzle-orm";
import db, { schema, type Transaction } from "@/database";
import { notDeleted } from "@/database/schemas/_soft-delete";
import { hardDelete, softDelete } from "@/database/soft-delete";
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
      .where(
        and(
          eq(schema.teamVaultFoldersTable.teamId, teamId),
          notDeleted(schema.teamVaultFoldersTable),
        ),
      )
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
   * Soft-delete a team's Vault folder mapping
   */
  static async delete(teamId: string, tx?: Transaction): Promise<boolean> {
    logger.debug(
      { teamId },
      "TeamVaultFolderModel.delete: soft-deleting team vault folder",
    );

    const existing = await TeamVaultFolderModel.findByTeamId(teamId);
    if (!existing) {
      return false;
    }

    await softDelete(
      tx ?? db,
      schema.teamVaultFoldersTable,
      eq(schema.teamVaultFoldersTable.teamId, teamId),
    );

    logger.debug({ teamId }, "TeamVaultFolderModel.delete: completed");
    return true;
  }

  /**
   * Hard-delete a team's Vault folder mapping. Reserved for purge flows.
   */
  static async hardDelete(teamId: string, tx?: Transaction): Promise<boolean> {
    const count = await hardDelete(
      tx ?? db,
      schema.teamVaultFoldersTable,
      eq(schema.teamVaultFoldersTable.teamId, teamId),
    );
    return count > 0;
  }
}

export default TeamVaultFolderModel;
