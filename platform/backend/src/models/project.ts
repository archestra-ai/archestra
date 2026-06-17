import { and, desc, eq, inArray, sql } from "drizzle-orm";
import db, { schema } from "@/database";
import type { InsertProject, Project } from "@/types";

/**
 * CRUD for `projects`. Share/visibility queries live in
 * {@link ProjectShareModel} (models/project-share.ts); the project's files
 * (`files.project_id`) are deleted with the project via the FK cascade.
 */
class ProjectModel {
  static async create(project: InsertProject): Promise<Project> {
    try {
      const [row] = await db
        .insert(schema.projectsTable)
        .values(project)
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

  static async updateDescription(params: {
    id: string;
    description: string | null;
  }): Promise<void> {
    await db
      .update(schema.projectsTable)
      .set({ description: params.description, updatedAt: new Date() })
      .where(eq(schema.projectsTable.id, params.id));
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
