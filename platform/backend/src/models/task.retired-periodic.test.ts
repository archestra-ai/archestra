import { eq } from "drizzle-orm";
import db, { schema } from "@/database";
import { TaskModel } from "@/models";
import { expect, test } from "@/test";

/**
 * Renaming or retiring a periodic task leaves its seeded row behind: the
 * seeding loop only ever adds, and a periodic task is re-scheduled by its own
 * handler rather than re-created from the list. The upgraded build then picks
 * up a row it has no handler for.
 */

async function seedPeriodic(taskType: string, periodic = true) {
  const [row] = await db
    .insert(schema.tasksTable)
    .values({
      // biome-ignore lint/suspicious/noExplicitAny: a retired type is by definition not in TaskType
      taskType: taskType as any,
      payload: {},
      status: "pending",
      periodic,
    })
    .returning();
  return row;
}

async function stillQueued(id: string): Promise<boolean> {
  const rows = await db
    .select({ id: schema.tasksTable.id })
    .from(schema.tasksTable)
    .where(eq(schema.tasksTable.id, id));
  return rows.length > 0;
}

test("removes a queued periodic task whose type this build no longer defines", async () => {
  const retired = await seedPeriodic("p4_shim_reap");

  const removed = await TaskModel.deleteRetiredPeriodicTasks([
    "check_due_connectors",
  ]);

  expect(removed).toBe(1);
  expect(await stillQueued(retired.id)).toBe(false);
});

test("keeps the periodic tasks the build still defines", async () => {
  const kept = await seedPeriodic("check_due_connectors");

  await TaskModel.deleteRetiredPeriodicTasks(["check_due_connectors"]);

  expect(await stillQueued(kept.id)).toBe(true);
});

test("never touches ordinary work, whatever its type", async () => {
  // Real work is enqueued with a payload and belongs to something; only the
  // rows seeded from the static periodic list are the sweep's business.
  const work = await seedPeriodic("connector_sync", false);

  await TaskModel.deleteRetiredPeriodicTasks(["check_due_connectors"]);

  expect(await stillQueued(work.id)).toBe(true);
});

test("deletes nothing when the known-type list is empty", async () => {
  // An empty list means "the caller could not say", not "nothing is known".
  // Reading it the other way would wipe every periodic task in the queue.
  const kept = await seedPeriodic("check_due_connectors");

  expect(await TaskModel.deleteRetiredPeriodicTasks([])).toBe(0);
  expect(await stillQueued(kept.id)).toBe(true);
});
