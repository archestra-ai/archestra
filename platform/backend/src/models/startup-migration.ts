import { eq, sql } from "drizzle-orm";
import db, { type Transaction } from "@/database";
import startupMigrationsTable from "@/database/schemas/startup-migration";

export default class StartupMigrationModel {
  /**
   * A failed or disconnected owner rolls back both data and completion, and
   * releases its transaction lock. Another replica can then retry safely.
   * Busy callers return immediately so waiting never consumes a SQL timeout.
   */
  static async tryRun(params: {
    id: string;
    migrate: (tx: Transaction) => Promise<void>;
  }): Promise<boolean> {
    const completed = await db
      .select({ id: startupMigrationsTable.id })
      .from(startupMigrationsTable)
      .where(eq(startupMigrationsTable.id, params.id));
    if (completed.length) return true;

    return db.transaction(async (tx) => {
      const lock = await tx.execute<{ acquired: boolean }>(sql`
        SELECT pg_try_advisory_xact_lock(hashtextextended(${`startup-migration:${params.id}`}, 0)) AS acquired
      `);
      if (!lock.rows[0]?.acquired) return false;

      // The owner could have committed between our fast check and the lock.
      const rechecked = await tx
        .select({ id: startupMigrationsTable.id })
        .from(startupMigrationsTable)
        .where(eq(startupMigrationsTable.id, params.id));
      if (rechecked.length) return true;

      // Data upgrades scale with existing data. The ordinary request timeout
      // must not repeatedly cancel a valid upgrade. LOCAL restores it at end.
      await tx.execute(sql`SET LOCAL statement_timeout = 0`);
      await params.migrate(tx);
      await tx.insert(startupMigrationsTable).values({ id: params.id });
      return true;
    });
  }
}
