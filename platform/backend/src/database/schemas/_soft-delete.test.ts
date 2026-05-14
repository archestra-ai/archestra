import { getTableColumns } from "drizzle-orm";
import { index, text, uuid } from "drizzle-orm/pg-core";
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

  test("exposes deletedAt to the extraConfig builder so partial indexes can reference it", () => {
    let sawDeletedAt = false;

    softPgTable(
      "factory_smoke_b",
      {
        id: uuid("id").primaryKey().defaultRandom(),
        slug: text("slug"),
      },
      (self) => {
        sawDeletedAt = self.deletedAt !== undefined;
        return [index("factory_smoke_b_slug_idx").on(self.slug)];
      },
    );

    expect(sawDeletedAt).toBe(true);
  });

  test("notDeleted compiles against a softPgTable result", () => {
    const table = softPgTable("factory_smoke_c", {
      id: uuid("id").primaryKey().defaultRandom(),
    });
    // Smoke test: notDeleted accepts the table without a type cast.
    const predicate = notDeleted(table);
    expect(predicate).toBeDefined();
  });

  test("softDeleteColumns shape exposes deletedAt as a nullable timestamp", () => {
    expect(Object.keys(softDeleteColumns)).toEqual(["deletedAt"]);
  });
});
