import { and, eq } from "drizzle-orm";
import db, { schema, withDbTransaction } from "@/database";
import {
  capDiagnosticEntries,
  mergeDiagnosticEntries,
} from "@/services/apps/app-diagnostics";
import type { AppRenderDiagnostics } from "@/types/app";
import type { AppRenderDiagnosticEntry } from "@/types/app-diagnostics";

const table = schema.appRenderDiagnosticsTable;

/**
 * The latest render diagnostics per `(app_id, user_id)`. Posted by the trusted
 * host page as a render settles and read back by `get_app_diagnostics`.
 */
class AppRenderDiagnosticsModel {
  /**
   * Record a render snapshot, race-safe and version-ordered: a post for a
   * version older than the stored one is ignored (stale tab); a newer version
   * replaces the row; the same version merges (so a clean render in one tab
   * cannot mask errors from a concurrent render of the same version).
   */
  static async record(params: {
    appId: string;
    userId: string;
    version: number;
    entries: AppRenderDiagnosticEntry[];
  }): Promise<void> {
    const entries = await capDiagnosticEntries(params.entries);

    // Claim the (app, user) row if it does not exist yet; otherwise fall through
    // to the version-aware update under a row lock. ON CONFLICT DO NOTHING makes
    // the first-render race (two tabs) safe — the loser merges on its next post.
    const inserted = await db
      .insert(table)
      .values({
        appId: params.appId,
        userId: params.userId,
        version: params.version,
        entries,
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
      if (params.version > existing.version) {
        await tx
          .update(table)
          .set({ version: params.version, entries, renderedAt: new Date() })
          .where(eq(table.id, existing.id));
        return;
      }
      const merged = await mergeDiagnosticEntries(existing.entries, entries);
      await tx
        .update(table)
        .set({ entries: merged, renderedAt: new Date() })
        .where(eq(table.id, existing.id));
    });
  }

  static async getForUser(
    appId: string,
    userId: string,
  ): Promise<AppRenderDiagnostics | null> {
    const [row] = await db
      .select()
      .from(table)
      .where(and(eq(table.appId, appId), eq(table.userId, userId)));
    return row ?? null;
  }
}

export default AppRenderDiagnosticsModel;
