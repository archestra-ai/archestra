import { sql } from "drizzle-orm";
import db from "@/database";
import { describe, expect, test } from "@/test";

describe("0235 migration: soft delete all objects", () => {
  test("installs soft-delete metadata, rule, and select policy on application tables", async () => {
    const columns = await db.execute<{ column_name: string }>(sql`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'team'
        AND column_name = 'deleted_at'
    `);
    const rules = await db.execute<{ rulename: string }>(sql`
      SELECT rulename
      FROM pg_rules
      WHERE schemaname = 'public'
        AND tablename = 'team'
        AND rulename = 'archestra_soft_delete'
    `);
    const policies = await db.execute<{ policyname: string }>(sql`
      SELECT policyname
      FROM pg_policies
      WHERE schemaname = 'public'
        AND tablename = 'team'
        AND policyname = 'archestra_select_not_deleted'
    `);
    const restoreFunctions = await db.execute<{ proname: string }>(sql`
      SELECT proname
      FROM pg_proc
      WHERE proname = 'archestra_restore_soft_deleted'
    `);

    expect(columns.rows[0]?.column_name).toBe("deleted_at");
    expect(rules.rows[0]?.rulename).toBe("archestra_soft_delete");
    expect(policies.rows[0]?.policyname).toBe("archestra_select_not_deleted");
    expect(restoreFunctions.rows[0]?.proname).toBe(
      "archestra_restore_soft_deleted",
    );
  });
});
