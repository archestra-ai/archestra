import { asc, eq } from "drizzle-orm";
import db, { schema } from "@/database";
import type {
  InsertSkillSandboxFileSnapshot,
  SkillSandboxFileSnapshot,
} from "@/types";

class SkillSandboxFileSnapshotModel {
  static async createMany(
    rows: InsertSkillSandboxFileSnapshot[],
  ): Promise<void> {
    if (rows.length === 0) return;
    await db.insert(schema.skillSandboxFileSnapshotsTable).values(rows);
  }

  /** All file snapshots for a sandbox, ordered by skill then path. */
  static async listBySandbox(
    sandboxId: string,
  ): Promise<SkillSandboxFileSnapshot[]> {
    return await db
      .select()
      .from(schema.skillSandboxFileSnapshotsTable)
      .where(eq(schema.skillSandboxFileSnapshotsTable.sandboxId, sandboxId))
      .orderBy(
        asc(schema.skillSandboxFileSnapshotsTable.skillId),
        asc(schema.skillSandboxFileSnapshotsTable.path),
      );
  }
}

export default SkillSandboxFileSnapshotModel;
