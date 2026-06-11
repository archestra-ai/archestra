import { and, asc, eq } from "drizzle-orm";
import db, { schema } from "@/database";
import type { SkillSandboxFolder } from "@/types";

/**
 * A user's PFS folders (`skill_sandbox_folders`). Names are unique per user
 * and double as the on-disk directory name in filesystem storage mode.
 */
class SkillSandboxFolderModel {
  static async create(params: {
    organizationId: string;
    userId: string;
    name: string;
  }): Promise<SkillSandboxFolder> {
    try {
      const [row] = await db
        .insert(schema.skillSandboxFoldersTable)
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

  static async listByUser(params: {
    organizationId: string;
    userId: string;
  }): Promise<SkillSandboxFolder[]> {
    return db
      .select()
      .from(schema.skillSandboxFoldersTable)
      .where(
        and(
          eq(
            schema.skillSandboxFoldersTable.organizationId,
            params.organizationId,
          ),
          eq(schema.skillSandboxFoldersTable.userId, params.userId),
        ),
      )
      .orderBy(asc(schema.skillSandboxFoldersTable.name));
  }

  static async findByName(params: {
    organizationId: string;
    userId: string;
    name: string;
  }): Promise<SkillSandboxFolder | null> {
    const [row] = await db
      .select()
      .from(schema.skillSandboxFoldersTable)
      .where(
        and(
          eq(
            schema.skillSandboxFoldersTable.organizationId,
            params.organizationId,
          ),
          eq(schema.skillSandboxFoldersTable.userId, params.userId),
          eq(schema.skillSandboxFoldersTable.name, params.name),
        ),
      );
    return row ?? null;
  }
}

export default SkillSandboxFolderModel;

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
