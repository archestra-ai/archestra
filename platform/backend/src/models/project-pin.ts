import { and, eq, inArray } from "drizzle-orm";
import db, { schema } from "@/database";

/**
 * Per-user project pins. Pinning a shared project is personal — it never
 * affects other members — so reads and writes are always scoped to a
 * (userId, projectId) pair.
 */
class ProjectPinModel {
  /** Pin a project for a user; idempotent (re-pin refreshes `pinnedAt`). */
  static async pin(params: {
    userId: string;
    projectId: string;
  }): Promise<void> {
    await db
      .insert(schema.projectPinsTable)
      .values({ userId: params.userId, projectId: params.projectId })
      .onConflictDoUpdate({
        target: [
          schema.projectPinsTable.userId,
          schema.projectPinsTable.projectId,
        ],
        set: { pinnedAt: new Date() },
      });
  }

  /** Remove a user's pin; idempotent (no-op when not pinned). */
  static async unpin(params: {
    userId: string;
    projectId: string;
  }): Promise<void> {
    await db
      .delete(schema.projectPinsTable)
      .where(
        and(
          eq(schema.projectPinsTable.userId, params.userId),
          eq(schema.projectPinsTable.projectId, params.projectId),
        ),
      );
  }

  /** `pinnedAt` per project for one user, in a single query (no N+1). */
  static async getPinnedAtForProjects(params: {
    userId: string;
    projectIds: string[];
  }): Promise<Map<string, Date>> {
    if (params.projectIds.length === 0) return new Map();
    const rows = await db
      .select({
        projectId: schema.projectPinsTable.projectId,
        pinnedAt: schema.projectPinsTable.pinnedAt,
      })
      .from(schema.projectPinsTable)
      .where(
        and(
          eq(schema.projectPinsTable.userId, params.userId),
          inArray(schema.projectPinsTable.projectId, params.projectIds),
        ),
      );
    const map = new Map<string, Date>();
    for (const r of rows) map.set(r.projectId, r.pinnedAt);
    return map;
  }
}

export default ProjectPinModel;
