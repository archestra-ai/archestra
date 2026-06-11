import { expect, test } from "@/test";
import SkillSandboxFolderModel, {
  SandboxFolderExistsError,
} from "./skill-sandbox-folder";

test("create + listByUser + findByName round-trip", async ({
  makeUser,
  makeOrganization,
}) => {
  const org = await makeOrganization();
  const user = await makeUser();

  const created = await SkillSandboxFolderModel.create({
    organizationId: org.id,
    userId: user.id,
    name: "reports",
  });
  expect(created.name).toBe("reports");

  await SkillSandboxFolderModel.create({
    organizationId: org.id,
    userId: user.id,
    name: "archive",
  });

  const listed = await SkillSandboxFolderModel.listByUser({
    organizationId: org.id,
    userId: user.id,
  });
  expect(listed.map((f) => f.name)).toEqual(["archive", "reports"]);

  const found = await SkillSandboxFolderModel.findByName({
    organizationId: org.id,
    userId: user.id,
    name: "reports",
  });
  expect(found?.id).toBe(created.id);

  expect(
    await SkillSandboxFolderModel.findByName({
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
  await SkillSandboxFolderModel.create({
    organizationId: org.id,
    userId: user.id,
    name: "reports",
  });
  await expect(
    SkillSandboxFolderModel.create({
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
  await SkillSandboxFolderModel.create({
    organizationId: org.id,
    userId: owner.id,
    name: "private",
  });

  expect(
    await SkillSandboxFolderModel.listByUser({
      organizationId: org.id,
      userId: other.id,
    }),
  ).toEqual([]);
  expect(
    await SkillSandboxFolderModel.findByName({
      organizationId: org.id,
      userId: other.id,
      name: "private",
    }),
  ).toBeNull();
});
