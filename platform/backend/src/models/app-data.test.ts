import { eq } from "drizzle-orm";
import db, { schema } from "@/database";
import { describe, expect, test } from "@/test";
import { ApiError } from "@/types";
import { APP_DATA_MAX_ENTRIES, APP_DATA_MAX_VALUE_BYTES } from "@/types/app";
import AppDataModel from "./app-data";

// A collaborative writer: no owner claim, full override — so ownership never
// affects these calls and we focus on partitioning/caps/round-trip behavior.
function collaborator(callerUserId = "writer") {
  return { callerUserId, callerCanOverrideOwner: true };
}

describe("AppDataModel", () => {
  test("round-trips get/set/list/keys/delete in the shared partition", async ({
    makeApp,
  }) => {
    const app = await makeApp();
    const shared = { appId: app.id, userId: null, ...collaborator() };
    await AppDataModel.set({ ...shared, key: "k1", value: { n: 1 } });
    await AppDataModel.set({ ...shared, key: "k2", value: "two" });

    expect(await AppDataModel.get({ ...shared, key: "k1" })).toMatchObject({
      value: { n: 1 },
      revision: 1,
      owner: null,
    });
    expect(await AppDataModel.keys(shared)).toEqual(["k1", "k2"]);
    expect(await AppDataModel.list(shared)).toEqual([
      { key: "k1", value: { n: 1 }, revision: 1, owner: null },
      { key: "k2", value: "two", revision: 1, owner: null },
    ]);

    // set on an existing key updates in place and bumps the revision
    const updated = await AppDataModel.set({
      ...shared,
      key: "k1",
      value: { n: 2 },
    });
    expect(updated).toMatchObject({ value: { n: 2 }, revision: 2 });
    expect(await AppDataModel.get({ ...shared, key: "k1" })).toMatchObject({
      value: { n: 2 },
      revision: 2,
    });

    expect(await AppDataModel.delete({ ...shared, key: "k1" })).toBe(true);
    expect(await AppDataModel.get({ ...shared, key: "k1" })).toBeNull();
  });

  test("round-trips values by identity, including JSON-looking strings", async ({
    makeApp,
  }) => {
    const app = await makeApp();
    const shared = { appId: app.id, userId: null, ...collaborator() };
    // a string that parses as JSON must come back as the same string — apps
    // commonly store JSON.stringify(...) output (localStorage habit), and a
    // double parse on read silently changes its type
    const cases: [string, unknown][] = [
      ["json-object-string", '{"x":1}'],
      ["json-number-string", "42"],
      ["json-bool-string", "true"],
      ["plain-string", "hello"],
      ["number", 42],
      ["nested", { a: [1, "2", { b: null }] }],
    ];
    for (const [key, value] of cases) {
      await AppDataModel.set({ ...shared, key, value });
      expect((await AppDataModel.get({ ...shared, key }))?.value).toStrictEqual(
        value,
      );
    }

    // top-level JSON null is reserved for "absent" and rejected cleanly,
    // including values that merely serialize to it
    for (const value of [null, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(
        AppDataModel.set({ ...shared, key: "null-value", value }),
      ).rejects.toBeInstanceOf(ApiError);
    }
  });

  test("rejects an oversized value cleanly", async ({ makeApp }) => {
    const app = await makeApp();
    const big = "x".repeat(APP_DATA_MAX_VALUE_BYTES + 1);
    await expect(
      AppDataModel.set({
        appId: app.id,
        userId: null,
        key: "big",
        value: big,
        ...collaborator(),
      }),
    ).rejects.toBeInstanceOf(ApiError);
  });

  test("isolates entries per app", async ({ makeApp }) => {
    const a = await makeApp();
    const b = await makeApp();
    await AppDataModel.set({
      appId: a.id,
      userId: null,
      key: "shared",
      value: "from-a",
      ...collaborator(),
    });
    expect(
      await AppDataModel.get({ appId: b.id, userId: null, key: "shared" }),
    ).toBeNull();
  });

  test("isolates user partitions from each other and from the shared store", async ({
    makeApp,
    makeUser,
  }) => {
    const app = await makeApp();
    const [alice, bob] = [await makeUser(), await makeUser()];
    const forAlice = { appId: app.id, userId: alice.id, ...collaborator() };
    const forBob = { appId: app.id, userId: bob.id, ...collaborator() };
    const shared = { appId: app.id, userId: null, ...collaborator() };

    await AppDataModel.set({ ...forAlice, key: "fav", value: "a" });
    await AppDataModel.set({ ...forBob, key: "fav", value: "b" });
    await AppDataModel.set({ ...shared, key: "fav", value: "everyone" });

    expect((await AppDataModel.get({ ...forAlice, key: "fav" }))?.value).toBe(
      "a",
    );
    expect((await AppDataModel.get({ ...forBob, key: "fav" }))?.value).toBe(
      "b",
    );
    expect((await AppDataModel.get({ ...shared, key: "fav" }))?.value).toBe(
      "everyone",
    );
    expect(await AppDataModel.list(forAlice)).toEqual([
      { key: "fav", value: "a", revision: 1, owner: null },
    ]);

    // deleting from one partition leaves the same key elsewhere intact
    expect(await AppDataModel.delete({ ...forAlice, key: "fav" })).toBe(true);
    expect((await AppDataModel.get({ ...forBob, key: "fav" }))?.value).toBe(
      "b",
    );
    expect((await AppDataModel.get({ ...shared, key: "fav" }))?.value).toBe(
      "everyone",
    );
  });

  test("enforces the entry cap per partition", async ({
    makeApp,
    makeUser,
  }) => {
    const app = await makeApp();
    const user = await makeUser();
    // seed the shared partition to the cap directly — looping 1000 model calls
    // (one transaction each) is prohibitively slow for a unit test
    await db.insert(schema.appDataTable).values(
      Array.from({ length: APP_DATA_MAX_ENTRIES }, (_, i) => ({
        appId: app.id,
        userId: null,
        key: `k${i}`,
        value: i,
      })),
    );

    const shared = { appId: app.id, userId: null, ...collaborator() };
    await expect(
      AppDataModel.set({ ...shared, key: "overflow", value: 1 }),
    ).rejects.toMatchObject({ statusCode: 409 });
    // existing keys still update once the partition is full
    await AppDataModel.set({ ...shared, key: "k0", value: "updated" });
    // and a different partition of the same app is unaffected
    await AppDataModel.set({
      appId: app.id,
      userId: user.id,
      key: "mine",
      value: 1,
      ...collaborator(),
    });
  });

  test("deleting a user cascades their partitions but not the shared store", async ({
    makeApp,
    makeUser,
  }) => {
    const app = await makeApp();
    const user = await makeUser();
    await AppDataModel.set({
      appId: app.id,
      userId: user.id,
      key: "mine",
      value: 1,
      ...collaborator(),
    });
    await AppDataModel.set({
      appId: app.id,
      userId: null,
      key: "ours",
      value: 2,
      ...collaborator(),
    });

    await db.delete(schema.usersTable).where(eq(schema.usersTable.id, user.id));

    expect(await AppDataModel.list({ appId: app.id, userId: user.id })).toEqual(
      [],
    );
    expect(
      (await AppDataModel.get({ appId: app.id, userId: null, key: "ours" }))
        ?.value,
    ).toBe(2);
  });
});

describe("AppDataModel optimistic concurrency", () => {
  test("expectedRevision must match the stored revision", async ({
    makeApp,
  }) => {
    const app = await makeApp();
    const shared = { appId: app.id, userId: null, ...collaborator() };

    const first = await AppDataModel.set({ ...shared, key: "k", value: "v1" });
    expect(first.revision).toBe(1);

    // a stale revision is a conflict
    await expect(
      AppDataModel.set({
        ...shared,
        key: "k",
        value: "stale",
        expectedRevision: 99,
      }),
    ).rejects.toMatchObject({ statusCode: 409 });

    // the current revision succeeds and bumps it
    const second = await AppDataModel.set({
      ...shared,
      key: "k",
      value: "v2",
      expectedRevision: 1,
    });
    expect(second.revision).toBe(2);
    expect((await AppDataModel.get({ ...shared, key: "k" }))?.value).toBe("v2");
  });

  test("expectedRevision 0 is insert-if-absent", async ({ makeApp }) => {
    const app = await makeApp();
    const shared = { appId: app.id, userId: null, ...collaborator() };

    // absent key → creates at revision 1
    const created = await AppDataModel.set({
      ...shared,
      key: "k",
      value: "first",
      expectedRevision: 0,
    });
    expect(created.revision).toBe(1);

    // existing key → conflict
    await expect(
      AppDataModel.set({
        ...shared,
        key: "k",
        value: "again",
        expectedRevision: 0,
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  test("a positive expectedRevision on an absent key is a conflict", async ({
    makeApp,
  }) => {
    const app = await makeApp();
    await expect(
      AppDataModel.set({
        appId: app.id,
        userId: null,
        key: "missing",
        value: 1,
        expectedRevision: 1,
        ...collaborator(),
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
  });
});

describe("AppDataModel shared-partition ownership", () => {
  test("an owned key rejects writes and deletes by a non-owner without override", async ({
    makeApp,
    makeUser,
  }) => {
    const app = await makeApp();
    const owner = await makeUser();
    const other = await makeUser();
    const shared = { appId: app.id, userId: null };

    const created = await AppDataModel.set({
      ...shared,
      key: "owned",
      value: "mine",
      claimOwner: true,
      callerUserId: owner.id,
      callerCanOverrideOwner: false,
    });
    expect(created.owner).toBe(owner.id);

    // a different user without override cannot overwrite
    await expect(
      AppDataModel.set({
        ...shared,
        key: "owned",
        value: "theirs",
        callerUserId: other.id,
        callerCanOverrideOwner: false,
      }),
    ).rejects.toMatchObject({ statusCode: 403 });

    // ...nor delete
    await expect(
      AppDataModel.delete({
        ...shared,
        key: "owned",
        callerUserId: other.id,
        callerCanOverrideOwner: false,
      }),
    ).rejects.toMatchObject({ statusCode: 403 });

    // the owner may overwrite
    const byOwner = await AppDataModel.set({
      ...shared,
      key: "owned",
      value: "updated",
      callerUserId: owner.id,
      callerCanOverrideOwner: false,
    });
    expect(byOwner.owner).toBe(owner.id);

    // an override caller (author/admin) may overwrite and delete
    await AppDataModel.set({
      ...shared,
      key: "owned",
      value: "by-admin",
      callerUserId: other.id,
      callerCanOverrideOwner: true,
    });
    expect(
      await AppDataModel.delete({
        ...shared,
        key: "owned",
        callerUserId: other.id,
        callerCanOverrideOwner: true,
      }),
    ).toBe(true);
  });

  test("claimOwner is ignored in the user partition (always private)", async ({
    makeApp,
    makeUser,
  }) => {
    const app = await makeApp();
    const user = await makeUser();
    const entry = await AppDataModel.set({
      appId: app.id,
      userId: user.id,
      key: "k",
      value: 1,
      claimOwner: true,
      callerUserId: user.id,
      callerCanOverrideOwner: false,
    });
    expect(entry.owner).toBeNull();
  });

  test("an unowned shared key is writable and deletable by any caller (backward-compat)", async ({
    makeApp,
    makeUser,
  }) => {
    const app = await makeApp();
    const someone = await makeUser();
    const shared = { appId: app.id, userId: null };

    // simulate a pre-migration row: revision defaulted, owner null
    await db.insert(schema.appDataTable).values({
      appId: app.id,
      userId: null,
      key: "legacy",
      value: "old",
    });

    const overwritten = await AppDataModel.set({
      ...shared,
      key: "legacy",
      value: "new",
      callerUserId: someone.id,
      callerCanOverrideOwner: false,
    });
    expect(overwritten.owner).toBeNull();
    expect(overwritten.revision).toBe(2);

    expect(
      await AppDataModel.delete({
        ...shared,
        key: "legacy",
        callerUserId: someone.id,
        callerCanOverrideOwner: false,
      }),
    ).toBe(true);
  });
});
