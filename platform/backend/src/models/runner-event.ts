import { asc, eq, sql } from "drizzle-orm";
import db, { schema } from "@/database";
import type { InsertRunnerEvent, RunnerEvent } from "@/types";

class RunnerEventModel {
  /**
   * Append one event, allocating its sequence atomically so concurrent
   * appends (a reaper transition racing a user's steer) can never collide.
   */
  static async append(event: InsertRunnerEvent): Promise<RunnerEvent> {
    return db.transaction(async (tx) => {
      const [row] = await tx
        .update(schema.runnersTable)
        .set({
          nextEventSequence: sql`${schema.runnersTable.nextEventSequence} + 1`,
        })
        .where(eq(schema.runnersTable.id, event.runnerId))
        .returning({ next: schema.runnersTable.nextEventSequence });
      if (!row) {
        throw new Error(
          `runner ${event.runnerId} does not exist while appending an event`,
        );
      }
      const [created] = await tx
        .insert(schema.runnerEventsTable)
        .values({
          runnerId: event.runnerId,
          kind: event.kind,
          message: event.message ?? null,
          payload: event.payload ?? null,
          actorUserId: event.actorUserId ?? null,
          sequence: row.next - 1,
        })
        .returning();
      return created;
    });
  }

  static async listForRunner(
    runnerId: string,
    limit = 200,
  ): Promise<RunnerEvent[]> {
    return db
      .select()
      .from(schema.runnerEventsTable)
      .where(eq(schema.runnerEventsTable.runnerId, runnerId))
      .orderBy(asc(schema.runnerEventsTable.sequence))
      .limit(limit);
  }
}

export default RunnerEventModel;
