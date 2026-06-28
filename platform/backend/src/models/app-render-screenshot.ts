import { and, eq } from "drizzle-orm";
import db, { schema, withDbTransaction } from "@/database";
import type { AppRenderScreenshot } from "@/types/app";

const table = schema.appRenderScreenshotTable;

/**
 * The latest render screenshot per `(app_id, user_id)`. Posted by the trusted
 * host page when an app self-captures, and read back by `get_app_diagnostics`.
 */
class AppRenderScreenshotModel {
  /**
   * Record a capture, race-safe and version-ordered: a post for a version older
   * than the stored one is ignored (stale tab); same-or-newer version replaces
   * the row. Unlike diagnostics there is nothing to merge — the newest capture
   * of the current version wins.
   */
  static async record(params: {
    appId: string;
    userId: string;
    version: number;
    mimeType: string;
    data: string;
  }): Promise<void> {
    const inserted = await db
      .insert(table)
      .values({
        appId: params.appId,
        userId: params.userId,
        version: params.version,
        mimeType: params.mimeType,
        data: params.data,
      })
      .onConflictDoNothing()
      .returning({ id: table.id });
    if (inserted.length > 0) return;

    await withDbTransaction(async (tx) => {
      const [existing] = await tx
        .select()
        .from(table)
        .where(
          and(eq(table.appId, params.appId), eq(table.userId, params.userId)),
        )
        .for("update");
      if (!existing) return;
      if (params.version < existing.version) return;
      await tx
        .update(table)
        .set({
          version: params.version,
          mimeType: params.mimeType,
          data: params.data,
          renderedAt: new Date(),
        })
        .where(eq(table.id, existing.id));
    });
  }

  static async getForUser(
    appId: string,
    userId: string,
  ): Promise<AppRenderScreenshot | null> {
    const [row] = await db
      .select()
      .from(table)
      .where(and(eq(table.appId, appId), eq(table.userId, userId)));
    return row ?? null;
  }
}

export default AppRenderScreenshotModel;
