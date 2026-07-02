import { PROJECT_MEMORY_MAX_ENTRIES_PER_PROJECT } from "@archestra/shared";
import { and, count, desc, eq, sql } from "drizzle-orm";
import db, { schema } from "@/database";
import type { ProjectMemory, ProjectMemoryItem } from "@/types";

/**
 * CRUD for `project_memories` — the short durable notes the assistant saves
 * for a project. Access control lives in the service (project owner/share);
 * this model only scopes queries by project + organization.
 */
class ProjectMemoryModel {
  /**
   * Insert one memory entry, enforcing the per-project entry cap. The parent
   * project row is locked `FOR UPDATE` for the duration of the transaction so
   * two concurrent saves can't both observe a count below the cap and
   * overshoot it (the count-then-insert is serialized per project).
   */
  static async create(params: {
    projectId: string;
    organizationId: string;
    createdByUserId: string;
    content: string;
  }): Promise<ProjectMemory> {
    return db.transaction(async (tx) => {
      const [locked] = await tx
        .select({ id: schema.projectsTable.id })
        .from(schema.projectsTable)
        .where(eq(schema.projectsTable.id, params.projectId))
        .for("update");
      if (!locked) throw new ProjectMemoryProjectGoneError();

      const [{ value: existing }] = await tx
        .select({ value: count() })
        .from(schema.projectMemoriesTable)
        .where(eq(schema.projectMemoriesTable.projectId, params.projectId));
      if (existing >= PROJECT_MEMORY_MAX_ENTRIES_PER_PROJECT) {
        throw new ProjectMemoryLimitError();
      }

      const [row] = await tx
        .insert(schema.projectMemoriesTable)
        .values(params)
        .returning();
      if (!row) throw new Error("failed to insert project memory");
      return row;
    });
  }

  /** All entries of a project, newest first, with author display names. */
  static async listByProject(params: {
    projectId: string;
    organizationId: string;
  }): Promise<ProjectMemoryItem[]> {
    const rows = await db
      .select({
        id: schema.projectMemoriesTable.id,
        content: schema.projectMemoriesTable.content,
        authorName: schema.usersTable.name,
        createdAt: schema.projectMemoriesTable.createdAt,
        updatedAt: schema.projectMemoriesTable.updatedAt,
      })
      .from(schema.projectMemoriesTable)
      .leftJoin(
        schema.usersTable,
        eq(schema.projectMemoriesTable.createdByUserId, schema.usersTable.id),
      )
      .where(
        and(
          eq(schema.projectMemoriesTable.projectId, params.projectId),
          eq(schema.projectMemoriesTable.organizationId, params.organizationId),
        ),
      )
      .orderBy(desc(schema.projectMemoriesTable.createdAt));
    return rows;
  }

  /**
   * Replace an entry's content. Scoped by project + org so a foreign id (or an
   * id from another project) reads as "not found". Returns null in that case.
   */
  static async update(params: {
    id: string;
    projectId: string;
    organizationId: string;
    content: string;
  }): Promise<ProjectMemory | null> {
    const [row] = await db
      .update(schema.projectMemoriesTable)
      .set({ content: params.content, updatedAt: sql`now()` })
      .where(
        and(
          eq(schema.projectMemoriesTable.id, params.id),
          eq(schema.projectMemoriesTable.projectId, params.projectId),
          eq(schema.projectMemoriesTable.organizationId, params.organizationId),
        ),
      )
      .returning();
    return row ?? null;
  }

  /** Delete an entry (same scoping as {@link update}). False = not found. */
  static async delete(params: {
    id: string;
    projectId: string;
    organizationId: string;
  }): Promise<boolean> {
    const deleted = await db
      .delete(schema.projectMemoriesTable)
      .where(
        and(
          eq(schema.projectMemoriesTable.id, params.id),
          eq(schema.projectMemoriesTable.projectId, params.projectId),
          eq(schema.projectMemoriesTable.organizationId, params.organizationId),
        ),
      )
      .returning({ id: schema.projectMemoriesTable.id });
    return deleted.length > 0;
  }
}

/** The per-project entry cap was hit; delete or consolidate entries first. */
export class ProjectMemoryLimitError extends Error {
  constructor() {
    super(
      `this project already has ${PROJECT_MEMORY_MAX_ENTRIES_PER_PROJECT} memories (the maximum); delete or consolidate existing memories first`,
    );
    this.name = "ProjectMemoryLimitError";
  }
}

/** The project vanished between the access check and the insert. */
export class ProjectMemoryProjectGoneError extends Error {
  constructor() {
    super("project not found");
    this.name = "ProjectMemoryProjectGoneError";
  }
}

export default ProjectMemoryModel;
