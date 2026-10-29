import { sql } from "drizzle-orm";
import { expect, test } from "vitest";
import db from "@/database";
import startupMigrationsTable from "@/database/schemas/startup-migration";
import StartupMigrationModel from "./startup-migration";

test("a completed upgrade never calls the migration again", async () => {
  let runs = 0;
  const migrate = async () => {
    runs++;
  };
  expect(await StartupMigrationModel.tryRun({ id: "once", migrate })).toBe(
    true,
  );
  expect(await StartupMigrationModel.tryRun({ id: "once", migrate })).toBe(
    true,
  );
  expect(runs).toBe(1);
});

test("failure rolls back upgrade writes and completion, allowing a retry", async () => {
  await expect(
    StartupMigrationModel.tryRun({
      id: "retry",
      migrate: async (tx) => {
        await tx
          .insert(startupMigrationsTable)
          .values({ id: "upgrade-effect" });
        throw new Error("interrupted upgrade");
      },
    }),
  ).rejects.toThrow("interrupted upgrade");
  expect(await db.select().from(startupMigrationsTable)).toEqual([]);
  expect(
    await StartupMigrationModel.tryRun({
      id: "retry",
      migrate: async (tx) => {
        await tx
          .insert(startupMigrationsTable)
          .values({ id: "upgrade-effect" });
      },
    }),
  ).toBe(true);
  expect(
    (await db.select().from(startupMigrationsTable))
      .map((row) => row.id)
      .sort(),
  ).toEqual(["retry", "upgrade-effect"]);
});

test("upgrade timeout override is transaction-local", async () => {
  const before = await db.execute<{ statement_timeout: string }>(
    sql`SHOW statement_timeout`,
  );
  await StartupMigrationModel.tryRun({
    id: "timeout",
    migrate: async (tx) => {
      const during = await tx.execute<{ statement_timeout: string }>(
        sql`SHOW statement_timeout`,
      );
      expect(during.rows[0].statement_timeout).toBe("0");
    },
  });
  expect(await db.execute(sql`SHOW statement_timeout`)).toEqual(before);
});
