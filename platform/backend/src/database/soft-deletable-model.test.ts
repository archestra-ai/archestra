import { sql } from "drizzle-orm";
import { text, uuid } from "drizzle-orm/pg-core";
import db from "@/database";
import { softPgTable } from "@/database/schemas/_soft-delete";
import { describe, expect, test } from "@/test";
import { SoftDeletableModel } from "./soft-deletable-model";

const scratchTable = softPgTable("soft_deletable_model_scratch", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
});

const SCRATCH_DDL = `
  CREATE TABLE IF NOT EXISTS soft_deletable_model_scratch (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    deleted_at TIMESTAMP NULL
  )
`;
const SCRATCH_DROP = `DROP TABLE IF EXISTS soft_deletable_model_scratch`;

async function setupScratch() {
  await db.execute(sql.raw(SCRATCH_DROP));
  await db.execute(sql.raw(SCRATCH_DDL));
}

class ScratchModel extends SoftDeletableModel<typeof scratchTable> {
  constructor() {
    super(scratchTable);
  }
}

describe("SoftDeletableModel", () => {
  test("findById hides soft-deleted rows by default, exposes them with includeDeleted", async () => {
    await setupScratch();
    const model = new ScratchModel();
    const [row] = await db
      .insert(scratchTable)
      .values({ name: "alpha" })
      .returning();

    await model.delete(row.id);

    expect(await model.findById(row.id)).toBeNull();

    const found = await model.findById(row.id, { includeDeleted: true });
    expect(found?.id).toBe(row.id);
    expect(found?.deletedAt).toBeInstanceOf(Date);
  });

  test("findAll filters soft-deleted rows by default", async () => {
    await setupScratch();
    const model = new ScratchModel();
    const [keep] = await db
      .insert(scratchTable)
      .values({ name: "keep" })
      .returning();
    const [drop] = await db
      .insert(scratchTable)
      .values({ name: "drop" })
      .returning();

    await model.delete(drop.id);

    const visible = await model.findAll();
    expect(visible.map((r) => r.id)).toEqual([keep.id]);

    const all = await model.findAll({ includeDeleted: true });
    expect(all).toHaveLength(2);
  });

  test("update refuses to touch soft-deleted rows", async () => {
    await setupScratch();
    const model = new ScratchModel();
    const [row] = await db
      .insert(scratchTable)
      .values({ name: "before" })
      .returning();

    await model.delete(row.id);

    const updated = await model.update(row.id, { name: "after" });
    expect(updated).toBeNull();

    const stored = await model.findById(row.id, { includeDeleted: true });
    expect(stored?.name).toBe("before");
  });

  test("restore round-trip: soft-delete then restore makes the row visible again", async () => {
    await setupScratch();
    const model = new ScratchModel();
    const [row] = await db
      .insert(scratchTable)
      .values({ name: "round-trip" })
      .returning();

    expect(await model.delete(row.id)).toBe(true);
    expect(await model.findById(row.id)).toBeNull();

    expect(await model.restore(row.id)).toBe(true);
    const restored = await model.findById(row.id);
    expect(restored?.deletedAt).toBeNull();
  });

  test("hardDelete physically removes the row", async () => {
    await setupScratch();
    const model = new ScratchModel();
    const [row] = await db
      .insert(scratchTable)
      .values({ name: "purge" })
      .returning();

    expect(await model.hardDelete(row.id)).toBe(true);
    expect(await model.findById(row.id, { includeDeleted: true })).toBeNull();
  });

  test("delete composes inside a transaction", async () => {
    await setupScratch();
    const model = new ScratchModel();
    const [row] = await db
      .insert(scratchTable)
      .values({ name: "tx" })
      .returning();

    await expect(
      db.transaction(async (tx) => {
        await model.delete(row.id, tx);
        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");

    const stored = await model.findById(row.id);
    expect(stored?.id).toBe(row.id);
    expect(stored?.deletedAt).toBeNull();
  });
});
