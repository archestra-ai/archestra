import { AppRenderDiagnosticsModel } from "@/models";
import { expect, test } from "@/test";

function entry(type: string, message: string) {
  return { type, message };
}

test("record then read returns the snapshot", async ({ makeApp, makeUser }) => {
  const app = await makeApp();
  const user = await makeUser();
  await AppRenderDiagnosticsModel.record({
    appId: app.id,
    userId: user.id,
    version: 1,
    entries: [entry("error", "boom")],
  });
  const row = await AppRenderDiagnosticsModel.getForUser(app.id, user.id);
  expect(row?.version).toBe(1);
  expect(row?.entries).toEqual([entry("error", "boom")]);
});

test("a stale (lower) version is ignored; a newer version replaces", async ({
  makeApp,
  makeUser,
}) => {
  const app = await makeApp();
  const user = await makeUser();
  await AppRenderDiagnosticsModel.record({
    appId: app.id,
    userId: user.id,
    version: 2,
    entries: [entry("error", "v2")],
  });

  // older render arriving late must not overwrite
  await AppRenderDiagnosticsModel.record({
    appId: app.id,
    userId: user.id,
    version: 1,
    entries: [entry("error", "v1")],
  });
  expect(
    (await AppRenderDiagnosticsModel.getForUser(app.id, user.id))?.version,
  ).toBe(2);

  // newer render replaces
  await AppRenderDiagnosticsModel.record({
    appId: app.id,
    userId: user.id,
    version: 3,
    entries: [],
  });
  const row = await AppRenderDiagnosticsModel.getForUser(app.id, user.id);
  expect(row?.version).toBe(3);
  expect(row?.entries).toEqual([]);
});

test("same-version posts merge and dedupe by type+message", async ({
  makeApp,
  makeUser,
}) => {
  const app = await makeApp();
  const user = await makeUser();
  await AppRenderDiagnosticsModel.record({
    appId: app.id,
    userId: user.id,
    version: 1,
    entries: [entry("error", "a")],
  });
  await AppRenderDiagnosticsModel.record({
    appId: app.id,
    userId: user.id,
    version: 1,
    entries: [entry("error", "a"), entry("console.error", "b")],
  });
  const row = await AppRenderDiagnosticsModel.getForUser(app.id, user.id);
  expect(row?.entries).toEqual([
    entry("error", "a"),
    entry("console.error", "b"),
  ]);
});

test("entries are capped at 20 and the message is truncated", async ({
  makeApp,
  makeUser,
}) => {
  const app = await makeApp();
  const user = await makeUser();
  const many = Array.from({ length: 30 }, (_, i) =>
    entry("error", `e${i}`.padEnd(700, "x")),
  );
  await AppRenderDiagnosticsModel.record({
    appId: app.id,
    userId: user.id,
    version: 1,
    entries: many,
  });
  const row = await AppRenderDiagnosticsModel.getForUser(app.id, user.id);
  expect(row?.entries).toHaveLength(20);
  expect(row?.entries[0].message.length).toBe(500);
});

test("snapshots are isolated per viewer", async ({ makeApp, makeUser }) => {
  const app = await makeApp();
  const userA = await makeUser();
  const userB = await makeUser();
  await AppRenderDiagnosticsModel.record({
    appId: app.id,
    userId: userA.id,
    version: 1,
    entries: [entry("error", "only-a")],
  });
  expect(
    (await AppRenderDiagnosticsModel.getForUser(app.id, userA.id))?.entries,
  ).toEqual([entry("error", "only-a")]);
  expect(
    await AppRenderDiagnosticsModel.getForUser(app.id, userB.id),
  ).toBeNull();
});
