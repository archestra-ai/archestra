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

/**
 * Thrown when a sandbox insert references a conversation that no longer
 * exists (e.g. deleted while the agent run was still in flight). Callers
 * should surface this as a user-visible error instead of a raw failed query.
 */
export class SkillSandboxConversationGoneError extends Error {
  constructor(conversationId: string) {
    super(`Conversation ${conversationId} no longer exists`);
    this.name = "SkillSandboxConversationGoneError";
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
    let rows: SkillSandbox[];
    try {
      rows = await db
        .insert(schema.skillSandboxesTable)
        .values(sandbox)
        .returning();
    } catch (error) {
      if (sandbox.conversationId && isConversationFkViolation(error)) {
        throw new SkillSandboxConversationGoneError(sandbox.conversationId);
      }
      throw error;
    }
    const [row] = rows;
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

    try {
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
    } catch (error) {
      // ON CONFLICT only absorbs unique violations; a deleted conversation
      // still surfaces as an FK violation here.
      if (isConversationFkViolation(error)) {
        throw new SkillSandboxConversationGoneError(conversationId);
      }
      throw error;
    }

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
      // the insert succeeded (or hit the unique index), so a missing row means
      // the conversation was deleted in between: the FK is ON DELETE SET NULL,
      // which detaches the default sandbox from the conversation.
      throw new SkillSandboxConversationGoneError(conversationId);
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

// === internal helpers ===

const CONVERSATION_FK_CONSTRAINT =
  "skill_sandboxes_conversation_id_conversations_id_fk";

// drizzle wraps the postgres error as `cause`; walk the chain to find it
function isConversationFkViolation(error: unknown): boolean {
  let current: unknown = error;
  while (current instanceof Error) {
    const candidate = current as Error & {
      code?: unknown;
      constraint?: unknown;
    };
    if (
      candidate.code === "23503" &&
      candidate.constraint === CONVERSATION_FK_CONSTRAINT
    ) {
      return true;
    }
    current = candidate.cause;
  }
  return false;
}
