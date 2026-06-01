import { eq, sql } from "drizzle-orm";
import { pgTable, text, uuid } from "drizzle-orm/pg-core";
import db from "@/database";
import { describe, expect, test } from "@/test";
import { notDeleted, softDeleteColumns } from "./schemas/soft-deletable-table";
import { hardDelete, restore, softDelete } from "./soft-delete";

const scratchTable = pgTable("soft_delete_scratch", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  ...softDeleteColumns,
});

const SCRATCH_DDL = `
  CREATE TABLE IF NOT EXISTS soft_delete_scratch (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    deleted_at TIMESTAMP NULL
  )
`;
const SCRATCH_DROP = `DROP TABLE IF EXISTS soft_delete_scratch`;

async function setupScratch() {
  await db.execute(sql.raw(SCRATCH_DROP));
  await db.execute(sql.raw(SCRATCH_DDL));
}

async function insertScratch(name: string): Promise<string> {
  const [row] = await db
    .insert(scratchTable)
    .values({ name })
    .returning({ id: scratchTable.id });
  return row.id;
}

async function readScratch(id: string) {
  const [row] = await db
    .select({ id: scratchTable.id, deletedAt: scratchTable.deletedAt })
    .from(scratchTable)
    .where(eq(scratchTable.id, id));
  return row ?? null;
}

describe("softDelete", () => {
  test("stamps deletedAt and returns the affected row count", async () => {
    await setupScratch();
    const id = await insertScratch("alpha");

    const count = await softDelete(db, scratchTable, eq(scratchTable.id, id));

    expect(count).toBe(1);
    expect((await readScratch(id))?.deletedAt).toBeInstanceOf(Date);
  });

  test("is idempotent on rows already soft-deleted", async () => {
    await setupScratch();
    const id = await insertScratch("beta");

    await softDelete(db, scratchTable, eq(scratchTable.id, id));
    const firstStamp = (await readScratch(id))?.deletedAt;

    await new Promise((r) => setTimeout(r, 5));
    const secondCount = await softDelete(
      db,
      scratchTable,
      eq(scratchTable.id, id),
    );

    expect(secondCount).toBe(0);
    expect((await readScratch(id))?.deletedAt?.getTime()).toBe(
      firstStamp?.getTime(),
    );
  });

  test("notDeleted filters soft-deleted rows out of selects", async () => {
    await setupScratch();
    const aliveId = await insertScratch("gamma");
    const deadId = await insertScratch("delta");
    await softDelete(db, scratchTable, eq(scratchTable.id, deadId));

    const rows = await db
      .select({ id: scratchTable.id })
      .from(scratchTable)
      .where(notDeleted(scratchTable));

    expect(rows.map((r) => r.id)).toEqual([aliveId]);
  });

  test("composes inside a transaction", async () => {
    await setupScratch();
    const id = await insertScratch("epsilon");

    await db.transaction(async (tx) => {
      await softDelete(tx, scratchTable, eq(scratchTable.id, id));
    });

    expect((await readScratch(id))?.deletedAt).toBeInstanceOf(Date);
  });

  test("rolls back when the surrounding transaction throws", async () => {
    await setupScratch();
    const id = await insertScratch("zeta");

    await expect(
      db.transaction(async (tx) => {
        await softDelete(tx, scratchTable, eq(scratchTable.id, id));
        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");

    expect((await readScratch(id))?.deletedAt).toBeNull();
  });
});

describe("restore", () => {
  test("clears deletedAt and only counts rows that were soft-deleted", async () => {
    await setupScratch();
    const id = await insertScratch("eta");
    await softDelete(db, scratchTable, eq(scratchTable.id, id));

    const restored = await restore(db, scratchTable, eq(scratchTable.id, id));
    expect(restored).toBe(1);
    expect((await readScratch(id))?.deletedAt).toBeNull();

    const restoredAgain = await restore(
      db,
      scratchTable,
      eq(scratchTable.id, id),
    );
    expect(restoredAgain).toBe(0);
  });
});

describe("hardDelete", () => {
  test("physically removes the row", async () => {
    await setupScratch();
    const id = await insertScratch("theta");

    const count = await hardDelete(db, scratchTable, eq(scratchTable.id, id));

    expect(count).toBe(1);
    expect(await readScratch(id)).toBeNull();
  });
});
