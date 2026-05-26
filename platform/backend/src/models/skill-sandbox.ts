import { asc, desc, eq, inArray } from "drizzle-orm";
import db, { schema } from "@/database";
import type {
  InsertSkillSandbox,
  InsertSkillSandboxFileSnapshot,
  SkillSandbox,
} from "@/types";

/**
 * Thrown when a skill file has a path that would escape the skill root (absolute
 * path or directory traversal). Callers should surface this as a user-visible error.
 */
export class SkillInvalidFilePathError extends Error {
  constructor(skillName: string, path: string) {
    super(
      `Skill "${skillName}" contains an invalid file path: ${JSON.stringify(path)}`,
    );
    this.name = "SkillInvalidFilePathError";
  }
}

class SkillSandboxModel {
  /**
   * Create a sandbox row together with its junction entries and an immutable file
   * snapshot in a single transaction. Skill content and files are fetched in a
   * single LEFT JOIN statement so the snapshot is always internally consistent
   * under PostgreSQL's default READ COMMITTED isolation — a concurrent
   * update_skill that commits while this method runs cannot produce a mixed
   * snapshot (old SKILL.md with new files, or vice versa).
   *
   * Throws {@link SkillInvalidFilePathError} if any mounted skill contains a file
   * with an absolute or traversal path.
   */
  static async create(params: {
    sandbox: InsertSkillSandbox;
    skillIds: string[];
  }): Promise<SkillSandbox> {
    return await db.transaction(async (tx) => {
      const [sandbox] = await tx
        .insert(schema.skillSandboxesTable)
        .values(params.sandbox)
        .returning();

      if (!sandbox) {
        throw new Error("failed to insert skill sandbox");
      }

      if (params.skillIds.length > 0) {
        await tx.insert(schema.skillSandboxSkillsTable).values(
          params.skillIds.map((skillId) => ({
            sandboxId: sandbox.id,
            skillId,
          })),
        );

        const joinRows = await tx
          .select({
            skill: schema.skillsTable,
            file: schema.skillFilesTable,
          })
          .from(schema.skillsTable)
          .leftJoin(
            schema.skillFilesTable,
            eq(schema.skillsTable.id, schema.skillFilesTable.skillId),
          )
          .where(inArray(schema.skillsTable.id, params.skillIds))
          .orderBy(asc(schema.skillFilesTable.path));

        // group join rows into a per-skill map (preserves file order from ORDER BY)
        const skillFileMap = new Map<
          string,
          {
            skill: (typeof joinRows)[number]["skill"];
            files: NonNullable<(typeof joinRows)[number]["file"]>[];
          }
        >();
        for (const row of joinRows) {
          const entry = skillFileMap.get(row.skill.id);
          if (entry) {
            if (row.file) entry.files.push(row.file);
          } else {
            skillFileMap.set(row.skill.id, {
              skill: row.skill,
              files: row.file ? [row.file] : [],
            });
          }
        }

        const snapshotRows: InsertSkillSandboxFileSnapshot[] = [];
        for (const { skill, files } of skillFileMap.values()) {
          snapshotRows.push({
            sandboxId: sandbox.id,
            skillId: skill.id,
            skillName: skill.name,
            path: "SKILL.md",
            encoding: "utf8",
            content: skill.content,
          });
          for (const file of files) {
            if (
              file.path.startsWith("/") ||
              file.path.split("/").some((s) => s === "..") ||
              file.path === "SKILL.md"
            ) {
              throw new SkillInvalidFilePathError(skill.name, file.path);
            }
            snapshotRows.push({
              sandboxId: sandbox.id,
              skillId: skill.id,
              skillName: skill.name,
              path: file.path,
              encoding: file.encoding,
              content: file.content,
            });
          }
        }

        if (snapshotRows.length > 0) {
          await tx
            .insert(schema.skillSandboxFileSnapshotsTable)
            .values(snapshotRows);
        }
      }

      return sandbox;
    });
  }

  static async findById(id: string): Promise<SkillSandbox | null> {
    const [result] = await db
      .select()
      .from(schema.skillSandboxesTable)
      .where(eq(schema.skillSandboxesTable.id, id));

    return result ?? null;
  }

  /** All sandboxes attached to a conversation, newest first. */
  static async listForConversation(
    conversationId: string,
  ): Promise<SkillSandbox[]> {
    return await db
      .select()
      .from(schema.skillSandboxesTable)
      .where(eq(schema.skillSandboxesTable.conversationId, conversationId))
      .orderBy(
        desc(schema.skillSandboxesTable.createdAt),
        desc(schema.skillSandboxesTable.id),
      );
  }

  /** Skill ids that were mounted into the sandbox at creation. */
  static async listSkillIds(sandboxId: string): Promise<string[]> {
    const rows = await db
      .select({ skillId: schema.skillSandboxSkillsTable.skillId })
      .from(schema.skillSandboxSkillsTable)
      .where(eq(schema.skillSandboxSkillsTable.sandboxId, sandboxId));
    return rows.map((r) => r.skillId);
  }
}

export default SkillSandboxModel;
