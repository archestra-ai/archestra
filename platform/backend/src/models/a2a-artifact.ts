import { eq, inArray } from "drizzle-orm";
import db, { schema } from "@/database";
import type { A2AArtifact } from "@/types";

/**
 * Reads for A2A task artifacts. All writes happen inside A2ATaskModel's
 * lifecycle transactions (delta append / complete), which is what keeps an
 * artifact consistent with the task state and event log.
 */
class A2AArtifactModel {
  static async findByTaskId(taskId: string): Promise<A2AArtifact[]> {
    return await db
      .select()
      .from(schema.a2aArtifactsTable)
      .where(eq(schema.a2aArtifactsTable.taskId, taskId))
      .orderBy(schema.a2aArtifactsTable.createdAt);
  }

  static async findByTaskIds(
    taskIds: string[],
  ): Promise<Map<string, A2AArtifact[]>> {
    if (taskIds.length === 0) {
      return new Map();
    }

    const rows = await db
      .select()
      .from(schema.a2aArtifactsTable)
      .where(inArray(schema.a2aArtifactsTable.taskId, taskIds))
      .orderBy(schema.a2aArtifactsTable.createdAt);

    const byTask = new Map<string, A2AArtifact[]>();
    for (const row of rows) {
      const list = byTask.get(row.taskId) ?? [];
      list.push(row);
      byTask.set(row.taskId, list);
    }
    return byTask;
  }
}

export default A2AArtifactModel;
