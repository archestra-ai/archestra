import { and, asc, eq, inArray } from "drizzle-orm";
import db, { schema } from "@/database";
import { notDeleted } from "@/database/schemas/soft-deletable-table";

/**
 * Apps linked into projects. A link never grants access to the app: callers
 * filter what they return by the viewer's own app access.
 */
class ProjectAppModel {
  /** Link an app into a project; idempotent (re-linking keeps the first link). */
  static async link(params: {
    projectId: string;
    appId: string;
    linkedBy: string;
  }): Promise<void> {
    await db
      .insert(schema.projectAppsTable)
      .values(params)
      .onConflictDoNothing({
        target: [
          schema.projectAppsTable.projectId,
          schema.projectAppsTable.appId,
        ],
      });
  }

  /** Remove a link; returns whether one existed. */
  static async unlink(params: {
    projectId: string;
    appId: string;
  }): Promise<boolean> {
    const rows = await db
      .delete(schema.projectAppsTable)
      .where(
        and(
          eq(schema.projectAppsTable.projectId, params.projectId),
          eq(schema.projectAppsTable.appId, params.appId),
        ),
      )
      .returning({ appId: schema.projectAppsTable.appId });
    return rows.length > 0;
  }

  /**
   * A project's linked, non-deleted apps, oldest link first, optionally
   * narrowed to `appIds` (the viewer's accessible apps) in the same query.
   */
  static async listForProject(params: {
    projectId: string;
    appIds?: string[];
  }): Promise<
    Array<{
      id: string;
      name: string;
      slug: string | null;
      description: string | null;
      linkedAt: Date;
    }>
  > {
    if (params.appIds?.length === 0) return [];
    return db
      .select({
        id: schema.appsTable.id,
        name: schema.appsTable.name,
        slug: schema.appsTable.slug,
        description: schema.appsTable.description,
        linkedAt: schema.projectAppsTable.linkedAt,
      })
      .from(schema.projectAppsTable)
      .innerJoin(
        schema.appsTable,
        eq(schema.projectAppsTable.appId, schema.appsTable.id),
      )
      .where(
        and(
          eq(schema.projectAppsTable.projectId, params.projectId),
          notDeleted(schema.appsTable),
          params.appIds
            ? inArray(schema.appsTable.id, params.appIds)
            : undefined,
        ),
      )
      .orderBy(asc(schema.projectAppsTable.linkedAt));
  }

  /** Every linked app id of a project, sorted — the audit snapshot's view. */
  static async listAppIds(projectId: string): Promise<string[]> {
    const rows = await db
      .select({ appId: schema.projectAppsTable.appId })
      .from(schema.projectAppsTable)
      .where(eq(schema.projectAppsTable.projectId, projectId));
    return rows.map((row) => row.appId).sort();
  }
}

export default ProjectAppModel;
