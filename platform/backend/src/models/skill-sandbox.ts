import { and, desc, eq } from "drizzle-orm";
import db, { schema } from "@/database";
import type {
  InsertSkillSandbox,
  SkillSandbox,
  SkillSandboxSkillMount,
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
   * Create an empty sandbox row. Skills are no longer fixed at creation — they
   * are mounted later via the replay log (see
   * `SkillSandboxReplayEventModel.appendSkillMount`), so a fresh sandbox starts
   * as a plain shell with nothing under `/skills`.
   */
  static async create(sandbox: InsertSkillSandbox): Promise<SkillSandbox> {
    const [row] = await db
      .insert(schema.skillSandboxesTable)
      .values(sandbox)
      .returning();
    if (!row) {
      throw new Error("failed to insert skill sandbox");
    }
    return row;
  }

  /**
   * Find the conversation's default sandbox or create it. The partial unique
   * index `(organization_id, user_id, conversation_id) WHERE is_default` makes
   * `INSERT ... ON CONFLICT DO NOTHING` safe under concurrent first calls: the
   * loser's insert is a no-op and both callers re-select the same row.
   */
  static async findOrCreateDefault(params: {
    organizationId: string;
    userId: string;
    conversationId: string;
    defaultCwd: string;
  }): Promise<SkillSandbox> {
    const { organizationId, userId, conversationId, defaultCwd } = params;

    await db
      .insert(schema.skillSandboxesTable)
      .values({
        organizationId,
        userId,
        conversationId,
        defaultCwd,
        isDefault: true,
      })
      .onConflictDoNothing();

    const [row] = await db
      .select()
      .from(schema.skillSandboxesTable)
      .where(
        and(
          eq(schema.skillSandboxesTable.organizationId, organizationId),
          eq(schema.skillSandboxesTable.userId, userId),
          eq(schema.skillSandboxesTable.conversationId, conversationId),
          eq(schema.skillSandboxesTable.isDefault, true),
        ),
      );
    if (!row) {
      throw new Error(
        `failed to find-or-create default sandbox for conversation ${conversationId}`,
      );
    }
    return row;
  }

  /** The conversation's default sandbox, if one has been created. */
  static async findDefault(params: {
    organizationId: string;
    userId: string;
    conversationId: string;
  }): Promise<SkillSandbox | null> {
    const [row] = await db
      .select()
      .from(schema.skillSandboxesTable)
      .where(
        and(
          eq(schema.skillSandboxesTable.organizationId, params.organizationId),
          eq(schema.skillSandboxesTable.userId, params.userId),
          eq(schema.skillSandboxesTable.conversationId, params.conversationId),
          eq(schema.skillSandboxesTable.isDefault, true),
        ),
      );
    return row ?? null;
  }

  static async findById(id: string): Promise<SkillSandbox | null> {
    const [result] = await db
      .select()
      .from(schema.skillSandboxesTable)
      .where(eq(schema.skillSandboxesTable.id, id));

    return result ?? null;
  }

  /** All sandboxes attached to a conversation within an org, newest first. */
  static async listForConversation(params: {
    conversationId: string;
    organizationId: string;
  }): Promise<SkillSandbox[]> {
    return await db
      .select()
      .from(schema.skillSandboxesTable)
      .where(
        and(
          eq(schema.skillSandboxesTable.conversationId, params.conversationId),
          eq(schema.skillSandboxesTable.organizationId, params.organizationId),
        ),
      )
      .orderBy(
        desc(schema.skillSandboxesTable.createdAt),
        desc(schema.skillSandboxesTable.id),
      );
  }

  /** Distinct skill ids mounted into the sandbox over its lifetime. */
  static async listMountedSkillIds(sandboxId: string): Promise<string[]> {
    const rows = await db
      .selectDistinct({ skillId: schema.skillSandboxSkillMountsTable.skillId })
      .from(schema.skillSandboxSkillMountsTable)
      .where(eq(schema.skillSandboxSkillMountsTable.sandboxId, sandboxId));
    return rows.map((r) => r.skillId);
  }

  /** The mount pinning a given skill in a sandbox, if the skill is mounted. */
  static async findMountBySkill(params: {
    sandboxId: string;
    skillId: string;
  }): Promise<SkillSandboxSkillMount | null> {
    const [row] = await db
      .select()
      .from(schema.skillSandboxSkillMountsTable)
      .where(
        and(
          eq(schema.skillSandboxSkillMountsTable.sandboxId, params.sandboxId),
          eq(schema.skillSandboxSkillMountsTable.skillId, params.skillId),
        ),
      );
    return row ?? null;
  }
}

export default SkillSandboxModel;
