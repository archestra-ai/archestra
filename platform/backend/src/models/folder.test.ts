import { sql } from "drizzle-orm";
import db, { schema } from "@/database";
import { describe, expect, test } from "@/test";
import FolderModel, { SandboxFolderExistsError } from "./folder";

describe("folders owner constraint", () => {
  test("rejects a folder with both user_id and project_id", async ({
    makeUser,
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const [project] = await db
      .insert(schema.projectsTable)
      .values({ organizationId: org.id, userId: user.id, name: "p" })
      .returning();
    await expect(
      db.execute(sql`
        INSERT INTO folders (organization_id, user_id, project_id, name)
        VALUES (${org.id}, ${user.id}, ${project.id}, 'both')
      `),
    ).rejects.toThrow();
  });

  test("rejects a folder with neither user_id nor project_id", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    await expect(
      db.execute(sql`
        INSERT INTO folders (organization_id, name) VALUES (${org.id}, 'neither')
      `),
    ).rejects.toThrow();
  });

  test("createForProject + findByProjectId round-trip", async ({
    makeUser,
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const [project] = await db
      .insert(schema.projectsTable)
      .values({ organizationId: org.id, userId: user.id, name: "proj" })
      .returning();
    const folder = await FolderModel.createForProject({
      organizationId: org.id,
      projectId: project.id,
      name: "proj",
    });
    expect(folder.userId).toBeNull();
    expect(folder.projectId).toBe(project.id);
    expect((await FolderModel.findByProjectId(project.id))?.id).toBe(folder.id);
    // a project folder never appears in a user's personal listing.
    expect(
      await FolderModel.listByUser({ organizationId: org.id, userId: user.id }),
    ).toEqual([]);
  });
});

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
