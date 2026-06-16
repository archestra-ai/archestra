import { and, asc, eq, inArray } from "drizzle-orm";
import db, { schema } from "@/database";
import type { SkillSandboxFolder } from "@/types";

/**
 * A user's PFS folders (`skill_sandbox_folders`). Names are unique per user
 * and double as the on-disk directory name in filesystem storage mode.
 */
class FolderModel {
  static async create(params: {
    organizationId: string;
    userId: string;
    name: string;
  }): Promise<SkillSandboxFolder> {
    try {
      const [row] = await db
        .insert(schema.foldersTable)
        .values(params)
        .returning();
      if (!row) throw new Error("failed to insert sandbox folder");
      return row;
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new SandboxFolderExistsError(params.name);
      }
      throw error;
    }
  }

  /** Create a project's result folder (owned by the project, no user). */
  static async createForProject(params: {
    organizationId: string;
    projectId: string;
    name: string;
  }): Promise<SkillSandboxFolder> {
    const [row] = await db
      .insert(schema.foldersTable)
      .values({
        organizationId: params.organizationId,
        projectId: params.projectId,
        name: params.name,
      })
      .returning();
    if (!row) throw new Error("failed to insert project folder");
    return row;
  }

  /** A user's PERSONAL folders only (project folders have a null user_id). */
  static async listByUser(params: {
    organizationId: string;
    userId: string;
  }): Promise<SkillSandboxFolder[]> {
    return db
      .select()
      .from(schema.foldersTable)
      .where(
        and(
          eq(schema.foldersTable.organizationId, params.organizationId),
          eq(schema.foldersTable.userId, params.userId),
        ),
      )
      .orderBy(asc(schema.foldersTable.name));
  }

  /** A project's result folder, or null if it no longer exists. */
  static async findByProjectId(
    projectId: string,
  ): Promise<SkillSandboxFolder | null> {
    const [row] = await db
      .select()
      .from(schema.foldersTable)
      .where(eq(schema.foldersTable.projectId, projectId));
    return row ?? null;
  }

  /** Batch variant of {@link findByProjectId}, keyed by project id. */
  static async findByProjectIds(
    projectIds: string[],
  ): Promise<Map<string, SkillSandboxFolder>> {
    if (projectIds.length === 0) return new Map();
    const rows = await db
      .select()
      .from(schema.foldersTable)
      .where(inArray(schema.foldersTable.projectId, projectIds));
    return new Map(
      rows.flatMap((row) => (row.projectId ? [[row.projectId, row]] : [])),
    );
  }

  static async findByName(params: {
    organizationId: string;
    userId: string;
    name: string;
  }): Promise<SkillSandboxFolder | null> {
    const [row] = await db
      .select()
      .from(schema.foldersTable)
      .where(
        and(
          eq(schema.foldersTable.organizationId, params.organizationId),
          eq(schema.foldersTable.userId, params.userId),
          eq(schema.foldersTable.name, params.name),
        ),
      );
    return row ?? null;
  }

  /** Batch fetch by id (for resolving project folder names in one query). */
  static async findByIds(
    ids: string[],
  ): Promise<Map<string, SkillSandboxFolder>> {
    if (ids.length === 0) return new Map();
    const rows = await db
      .select()
      .from(schema.foldersTable)
      .where(inArray(schema.foldersTable.id, ids));
    return new Map(rows.map((row) => [row.id, row]));
  }

  /**
   * Remove a folder row — only used to roll back a folder created for a
   * project whose own insert then failed. There is no user-facing delete.
   */
  static async deleteById(id: string): Promise<void> {
    await db.delete(schema.foldersTable).where(eq(schema.foldersTable.id, id));
  }
}

export default FolderModel;

/** The user already has a folder with this name. */
export class SandboxFolderExistsError extends Error {
  constructor(name: string) {
    super(`a folder named "${name}" already exists`);
    this.name = "SandboxFolderExistsError";
  }
}

// === internal ===

/** Postgres unique_violation, as surfaced by pg and PGlite drivers. */
function isUniqueViolation(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const code = (error as { code?: string }).code;
  const cause = (error as { cause?: { code?: string } }).cause;
  return code === "23505" || cause?.code === "23505";
}
