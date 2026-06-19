import { randomUUID } from "node:crypto";
import { urlSlugify } from "@archestra/shared";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
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
    }[]
  > {
    return db
      .select({
        id: schema.conversationsTable.id,
        title: schema.conversationsTable.title,
        authorUserId: schema.conversationsTable.userId,
        authorName: schema.usersTable.name,
        origin: schema.conversationsTable.origin,
        lastMessageAt: schema.conversationsTable.lastMessageAt,
        createdAt: schema.conversationsTable.createdAt,
      })
      .from(schema.conversationsTable)
      .leftJoin(
        schema.usersTable,
        eq(schema.conversationsTable.userId, schema.usersTable.id),
      )
      .where(eq(schema.conversationsTable.projectId, projectId))
      .orderBy(desc(schema.conversationsTable.lastMessageAt));
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

// === internal ===

/** Postgres unique_violation, as surfaced by pg and PGlite drivers. */
function isUniqueViolation(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const code = (error as { code?: string }).code;
  const cause = (error as { cause?: { code?: string } }).cause;
  return code === "23505" || cause?.code === "23505";
}
