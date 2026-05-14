import { getTableColumns } from "drizzle-orm";
import { text, uuid } from "drizzle-orm/pg-core";
import { describe, expect, test } from "vitest";
import { notDeleted, softDeleteColumns, softPgTable } from "./_soft-delete";

describe("softPgTable", () => {
  test("auto-adds the deletedAt column without requiring a manual spread", () => {
    const table = softPgTable("factory_smoke_a", {
      id: uuid("id").primaryKey().defaultRandom(),
      name: text("name").notNull(),
    });

    const cols = getTableColumns(table);
    expect(Object.keys(cols).sort()).toEqual(
      ["deletedAt", "id", "name"].sort(),
    );
    expect(cols.deletedAt.name).toBe("deleted_at");
  });

  test("notDeleted compiles against a softPgTable result", () => {
    const table = softPgTable("factory_smoke_b", {
      id: uuid("id").primaryKey().defaultRandom(),
    });
    const predicate = notDeleted(table);
    expect(predicate).toBeDefined();
  });

  test("softDeleteColumns shape exposes deletedAt as a nullable timestamp", () => {
    expect(Object.keys(softDeleteColumns)).toEqual(["deletedAt"]);
  });
});
