import { expect, test } from "@/test";
import FolderModel, { SandboxFolderExistsError } from "./folder";

test("create + listByUser + findByName round-trip", async ({
  makeUser,
  makeOrganization,
}) => {
  const org = await makeOrganization();
  const user = await makeUser();

  const created = await FolderModel.create({
    organizationId: org.id,
    userId: user.id,
    name: "reports",
  });
  expect(created.name).toBe("reports");

  await FolderModel.create({
    organizationId: org.id,
    userId: user.id,
    name: "archive",
  });

  const listed = await FolderModel.listByUser({
    organizationId: org.id,
    userId: user.id,
  });
  expect(listed.map((f) => f.name)).toEqual(["archive", "reports"]);

  const found = await FolderModel.findByName({
    organizationId: org.id,
    userId: user.id,
    name: "reports",
  });
  expect(found?.id).toBe(created.id);

  expect(
    await FolderModel.findByName({
      organizationId: org.id,
      userId: user.id,
      name: "nope",
    }),
  ).toBeNull();
});

test("duplicate name for the same user throws SandboxFolderExistsError", async ({
  makeUser,
  makeOrganization,
}) => {
  const org = await makeOrganization();
  const user = await makeUser();
  await FolderModel.create({
    organizationId: org.id,
    userId: user.id,
    name: "reports",
  });
  await expect(
    FolderModel.create({
      organizationId: org.id,
      userId: user.id,
      name: "reports",
    }),
  ).rejects.toBeInstanceOf(SandboxFolderExistsError);
});

test("folders are invisible to other users", async ({
  makeUser,
  makeOrganization,
}) => {
  const org = await makeOrganization();
  const owner = await makeUser();
  const other = await makeUser();
  await FolderModel.create({
    organizationId: org.id,
    userId: owner.id,
    name: "private",
  });

  expect(
    await FolderModel.listByUser({
      organizationId: org.id,
      userId: other.id,
    }),
  ).toEqual([]);
  expect(
    await FolderModel.findByName({
      organizationId: org.id,
      userId: other.id,
      name: "private",
    }),
  ).toBeNull();
});
