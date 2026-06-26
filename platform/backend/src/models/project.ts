import { randomUUID } from "node:crypto";
import { urlSlugify } from "@archestra/shared";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import db, { schema } from "@/database";
import type { ConversationOrigin, InsertProject, Project } from "@/types";

/**
 * CRUD for `projects`. Share/visibility queries live in
 * {@link ProjectShareModel} (models/project-share.ts); the project's files
 * (`files.project_id`) are deleted with the project via the FK cascade.
 */
class ProjectModel {
  static async create(project: InsertProject): Promise<Project> {
    const slug = await ProjectModel.generateUniqueSlug({
      name: project.name,
      organizationId: project.organizationId,
    });
    try {
      const [row] = await db
        .insert(schema.projectsTable)
        .values({ ...project, slug })
        .returning();
      if (!row) throw new Error("failed to insert project");
      return row;
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ProjectNameExistsError(project.name);
      }
      throw error;
    }
  }

  /**
   * Turn an existing chat into a project, atomically: create the project, move
   * the chat into it (`conversations.project_id`), and re-point the chat's
   * no-project files to the project (`files.project_id`). All in one
   * transaction so a failure leaves no orphaned project or half-moved files.
   *
   * The conversation row is locked `FOR UPDATE` so two concurrent conversions
   * of the same chat can't both create a project (the loser sees `project_id`
   * already set). The caller (service) owns eligibility/validation; this method
   * re-checks ownership and the not-already-assigned invariant under the lock.
   */
  static async createFromConversation(params: {
    organizationId: string;
    userId: string;
    conversationId: string;
    name: string;
    description: string | null;
    icon: string | null;
  }): Promise<{ project: Project; filesMoved: number }> {
    // Computed outside the tx: `generateUniqueSlug` reads the module-level `db`,
    // and the partial unique index is the real guard against a slug race.
    const slug = await ProjectModel.generateUniqueSlug({
      name: params.name,
      organizationId: params.organizationId,
    });

    return db.transaction(async (tx) => {
      const [conversation] = await tx
        .select({
          id: schema.conversationsTable.id,
          projectId: schema.conversationsTable.projectId,
        })
        .from(schema.conversationsTable)
        .where(
          and(
            eq(schema.conversationsTable.id, params.conversationId),
            eq(schema.conversationsTable.userId, params.userId),
            eq(schema.conversationsTable.organizationId, params.organizationId),
          ),
        )
        .for("update");
      if (!conversation) throw new ConversationNotOwnedError();
      if (conversation.projectId) throw new ProjectAlreadyAssignedError();

      // A brand-new project is empty, so the only filename clash the re-point
      // can hit is two same-named no-project files in this chat (e.g. distinct
      // authors). Detect it up front for a clear error instead of an opaque
      // unique-violation rollback.
      const movable = await tx
        .select({ filename: schema.filesTable.filename })
        .from(schema.filesTable)
        .where(
          and(
            eq(schema.filesTable.organizationId, params.organizationId),
            eq(schema.filesTable.conversationId, params.conversationId),
            isNull(schema.filesTable.projectId),
          ),
        );
      const seen = new Set<string>();
      for (const { filename } of movable) {
        if (seen.has(filename)) {
          throw new ProjectFileNameConflictError(filename);
        }
        seen.add(filename);
      }

      let project: Project;
      try {
        const [row] = await tx
          .insert(schema.projectsTable)
          .values({
            organizationId: params.organizationId,
            userId: params.userId,
            name: params.name,
            description: params.description,
            icon: params.icon,
            slug,
          })
          .returning();
        if (!row) throw new Error("failed to insert project");
        project = row;
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw new ProjectNameExistsError(params.name);
        }
        throw error;
      }

      await tx
        .update(schema.conversationsTable)
        .set({ projectId: project.id })
        .where(eq(schema.conversationsTable.id, params.conversationId));

      const moved = await tx
        .update(schema.filesTable)
        .set({ projectId: project.id })
        .where(
          and(
            eq(schema.filesTable.organizationId, params.organizationId),
            eq(schema.filesTable.conversationId, params.conversationId),
            isNull(schema.filesTable.projectId),
          ),
        )
        .returning({ id: schema.filesTable.id });

      return { project, filesMoved: moved.length };
    });
  }

  static async findById(id: string): Promise<Project | null> {
    const [row] = await db
      .select()
      .from(schema.projectsTable)
      .where(eq(schema.projectsTable.id, id));
    return row ?? null;
  }

  /** Owner-scoped fetch — for mutations, which only the owner may perform. */
  static async findByIdForOwner(params: {
    id: string;
    userId: string;
    organizationId: string;
  }): Promise<Project | null> {
    const [row] = await db
      .select()
      .from(schema.projectsTable)
      .where(
        and(
          eq(schema.projectsTable.id, params.id),
          eq(schema.projectsTable.userId, params.userId),
          eq(schema.projectsTable.organizationId, params.organizationId),
        ),
      );
    return row ?? null;
  }

  /**
   * Update the owner-editable fields. Only the keys present in `fields` are
   * written, so a caller can change name, description, and/or icon
   * independently. A duplicate name surfaces as {@link ProjectNameExistsError}.
   */
  static async update(params: {
    id: string;
    fields: {
      name?: string;
      description?: string | null;
      icon?: string | null;
    };
  }): Promise<void> {
    try {
      await db
        .update(schema.projectsTable)
        .set({ ...params.fields, updatedAt: new Date() })
        .where(eq(schema.projectsTable.id, params.id));
    } catch (error) {
      if (isUniqueViolation(error) && params.fields.name !== undefined) {
        throw new ProjectNameExistsError(params.fields.name);
      }
      throw error;
    }
  }

  static async delete(id: string): Promise<void> {
    await db
      .delete(schema.projectsTable)
      .where(eq(schema.projectsTable.id, id));
  }

  /** Conversation counts for a set of projects, in one grouped query. */
  static async countConversations(
    projectIds: string[],
  ): Promise<Map<string, number>> {
    if (projectIds.length === 0) return new Map();
    const rows = await db
      .select({
        projectId: schema.conversationsTable.projectId,
        count: sql<number>`count(*)::int`,
      })
      .from(schema.conversationsTable)
      .where(inArray(schema.conversationsTable.projectId, projectIds))
      .groupBy(schema.conversationsTable.projectId);
    const map = new Map<string, number>();
    for (const r of rows) {
      if (r.projectId) map.set(r.projectId, r.count);
    }
    return map;
  }

  /** All chats of one project, newest activity first, with author names. */
  static async listConversations(projectId: string): Promise<
    {
      id: string;
      title: string | null;
      authorUserId: string;
      authorName: string | null;
      origin: ConversationOrigin;
      lastMessageAt: Date;
      createdAt: Date;
      // The schedule + run that produced a `schedule_trigger` chat (null for
      // user chats); lets the chat list collapse a schedule's runs into one row
      // and open the latest run with its sidebar runs navigator.
      scheduleTriggerId: string | null;
      scheduleRunId: string | null;
      // The schedule's display name, shown on a collapsed scheduled chat row.
      scheduleName: string | null;
    }[]
  > {
    return (
      db
        .select({
          id: schema.conversationsTable.id,
          title: schema.conversationsTable.title,
          authorUserId: schema.conversationsTable.userId,
          authorName: schema.usersTable.name,
          origin: schema.conversationsTable.origin,
          lastMessageAt: schema.conversationsTable.lastMessageAt,
          createdAt: schema.conversationsTable.createdAt,
          scheduleTriggerId: schema.scheduleTriggerRunsTable.triggerId,
          scheduleRunId: schema.scheduleTriggerRunsTable.id,
          scheduleName: schema.scheduleTriggersTable.name,
        })
        .from(schema.conversationsTable)
        .leftJoin(
          schema.usersTable,
          eq(schema.conversationsTable.userId, schema.usersTable.id),
        )
        // 1:1 — a conversation is linked by at most one run (CAS-set), so this
        // never fans out conversation rows.
        .leftJoin(
          schema.scheduleTriggerRunsTable,
          eq(
            schema.scheduleTriggerRunsTable.chatConversationId,
            schema.conversationsTable.id,
          ),
        )
        .leftJoin(
          schema.scheduleTriggersTable,
          eq(
            schema.scheduleTriggersTable.id,
            schema.scheduleTriggerRunsTable.triggerId,
          ),
        )
        .where(eq(schema.conversationsTable.projectId, projectId))
        .orderBy(desc(schema.conversationsTable.lastMessageAt))
    );
  }

  // === internal ===

  /**
   * A URL-safe slug for the project's filesystem folder, unique within the org.
   * Derived from the name; on a base-slug collision a short random suffix keeps
   * it distinct (the unique index is the final guard against a create race).
   */
  private static async generateUniqueSlug(params: {
    name: string;
    organizationId: string;
  }): Promise<string> {
    const baseSlug = urlSlugify(params.name) || "project";
    const [existing] = await db
      .select({ id: schema.projectsTable.id })
      .from(schema.projectsTable)
      .where(
        and(
          eq(schema.projectsTable.organizationId, params.organizationId),
          eq(schema.projectsTable.slug, baseSlug),
        ),
      )
      .limit(1);
    return existing ? `${baseSlug}-${randomUUID().slice(0, 6)}` : baseSlug;
  }
}

export default ProjectModel;

/** The user already has a project with this name. */
export class ProjectNameExistsError extends Error {
  constructor(name: string) {
    super(`a project named "${name}" already exists`);
    this.name = "ProjectNameExistsError";
  }
}

/** The conversation does not exist or is not owned by the caller. */
export class ConversationNotOwnedError extends Error {
  constructor() {
    super("conversation not found");
    this.name = "ConversationNotOwnedError";
  }
}

/** The conversation is already part of a project, so it can't seed a new one. */
export class ProjectAlreadyAssignedError extends Error {
  constructor() {
    super("conversation already belongs to a project");
    this.name = "ProjectAlreadyAssignedError";
  }
}

/** Two files being moved into the new project share a name. */
export class ProjectFileNameConflictError extends Error {
  constructor(filename: string) {
    super(`two files named "${filename}" can't move into the same project`);
    this.name = "ProjectFileNameConflictError";
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
