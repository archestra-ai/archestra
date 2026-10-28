import { eq } from "drizzle-orm";
import db, { schema } from "@/database";
import {
  type RoutingScorerSpec,
  type RoutingScorerVersion,
  SelectRoutingScorerVersionSchema,
} from "@/types/auto-routing";

const versions = schema.routingScorerVersionsTable;

class RoutingScorerVersionModel {
  /**
   * The version for this spec, created on first sight. `specHash` is the
   * sha256 of the canonical spec, so any spec edit is a new version.
   */
  static async upsert(params: {
    name: string;
    model: string;
    spec: RoutingScorerSpec;
    specHash: string;
  }): Promise<RoutingScorerVersion> {
    const [inserted] = await db
      .insert(versions)
      .values(params)
      .onConflictDoNothing({ target: versions.specHash })
      .returning();
    const [row] = inserted
      ? [inserted]
      : await db
          .select()
          .from(versions)
          .where(eq(versions.specHash, params.specHash));
    if (!row)
      throw new Error("Scorer version conflicted but could not be read");
    return SelectRoutingScorerVersionSchema.parse(row);
  }
}

export default RoutingScorerVersionModel;
