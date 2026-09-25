import { count } from "drizzle-orm";
import db, { schema } from "@/database";
import ModelModel from "@/models/model";
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

  test("persists a model written inside a transaction", async () => {
    await ModelModel.bulkUpsert([
      {
        externalId: "openai/test-isolation",
        provider: "openai",
        modelId: "test-isolation",
        inputModalities: null,
        outputModalities: null,
      },
    ]);
    expect(
      await ModelModel.findByProviderAndModelId("openai", "test-isolation"),
    ).not.toBeNull();
  });

  test("removes transaction rows before the next test", async () => {
    expect(
      await ModelModel.findByProviderAndModelId("openai", "test-isolation"),
    ).toBeNull();
  });
});
