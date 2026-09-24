import { count } from "drizzle-orm";
import db, { schema } from "@/database";
import { describe, expect, test } from "@/test";

describe.sequential("test database isolation", () => {
  test("persists a fixture row within its test", async ({ makeUser }) => {
    await makeUser();

    const [{ total }] = await db
      .select({ total: count() })
      .from(schema.usersTable);
    expect(total).toBe(1);
  });

  test("removes the previous test's rows before the next test", async () => {
    const [{ total }] = await db
      .select({ total: count() })
      .from(schema.usersTable);
    expect(total).toBe(0);
  });
});
